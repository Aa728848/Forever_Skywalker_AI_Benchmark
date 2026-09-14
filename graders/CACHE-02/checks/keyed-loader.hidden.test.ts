import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyedLoader } from '../starter/src/keyed-loader.ts';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

/** 可控调度：受信方自行决定结算时机；本文件不导入工作区内的任何辅助模块。 */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onValue, onError) => {
    resolve = onValue;
    reject = onError;
  });
  return { promise, resolve, reject };
}

test('hidden/three-way-single-load', async () => {
  const gate = deferred<number>();
  let calls = 0;
  const loader = new KeyedLoader<number>(() => {
    calls += 1;
    return gate.promise;
  });

  const callers = [loader.load('cfg:region'), loader.load('cfg:region'), loader.load('cfg:region')];
  assert.equal(calls, 1);
  gate.resolve(42);
  assert.deepEqual(await Promise.all(callers), [42, 42, 42]);
  assert.equal(calls, 1);
});

test('hidden/joined-callers-same-error-identity', async () => {
  const gate = deferred<string>();
  const failure = { code: 'E_LOAD', retryable: true };
  let calls = 0;
  const loader = new KeyedLoader<string>(() => {
    calls += 1;
    return gate.promise;
  });

  const first = loader.load('token');
  const second = loader.load('token');
  gate.reject(failure);

  await assert.rejects(first, (error: unknown) => error === failure);
  await assert.rejects(second, (error: unknown) => error === failure);
  assert.equal(calls, 1);
});

test('hidden/no-cache-of-rejected-attempt', async () => {
  const failure = new Error('transient failure');
  let calls = 0;
  const loader = new KeyedLoader<string>((key) => {
    calls += 1;
    return calls === 1 ? Promise.reject(failure) : Promise.resolve(`ok:${key}`);
  });

  await assert.rejects(loader.load('report'), (error: unknown) => error === failure);
  assert.equal(loader.has('report'), false);
  assert.equal(loader.size, 0);
  assert.equal(await loader.load('report'), 'ok:report');
  assert.equal(calls, 2);
  assert.equal(loader.size, 1);
});

test('hidden/retry-then-coalesce-again', async () => {
  const firstGate = deferred<string>();
  const retryGate = deferred<string>();
  let calls = 0;
  const loader = new KeyedLoader<string>(() => {
    calls += 1;
    return calls === 1 ? firstGate.promise : retryGate.promise;
  });

  const attempt = loader.load('dataset');
  firstGate.reject(new Error('first attempt failed'));
  await assert.rejects(attempt);

  const retryA = loader.load('dataset');
  const retryB = loader.load('dataset');
  assert.equal(calls, 2);
  retryGate.resolve('payload');
  assert.deepEqual(await Promise.all([retryA, retryB]), ['payload', 'payload']);
  assert.equal(calls, 2);
  assert.equal(loader.size, 1);
});

test('hidden/delete-during-inflight-keeps-result', async () => {
  const gate = deferred<string>();
  let calls = 0;
  const loader = new KeyedLoader<string>(() => {
    calls += 1;
    return gate.promise;
  });

  const pending = loader.load('inventory');
  assert.equal(loader.delete('inventory'), false);
  assert.equal(loader.size, 0);
  gate.resolve('stock');
  assert.equal(await pending, 'stock');
  assert.equal(loader.has('inventory'), true);
  assert.equal(loader.size, 1);
  assert.equal(await loader.load('inventory'), 'stock');
  assert.equal(calls, 1);
});

test('hidden/clear-does-not-affect-inflight', async () => {
  const gate = deferred<number>();
  const loader = new KeyedLoader<number>((key) => (key === 'slow' ? gate.promise : Promise.resolve(7)));

  assert.equal(await loader.load('fast'), 7);
  const pending = loader.load('slow');
  loader.clear();
  assert.equal(loader.size, 0);
  gate.resolve(9);
  assert.equal(await pending, 9);
  assert.equal(loader.size, 1);
  assert.equal(loader.has('slow'), true);
  assert.equal(loader.has('fast'), false);
});

test('hidden/keys-are-not-serialized', async () => {
  const gates = new Map<string, Deferred<string>>([
    ['alpha', deferred<string>()],
    ['beta', deferred<string>()],
    ['gamma', deferred<string>()],
  ]);
  const started: string[] = [];
  const loader = new KeyedLoader<string>((key) => {
    started.push(key);
    return gates.get(key)!.promise;
  });

  const pending = ['alpha', 'beta', 'gamma'].map((key) => loader.load(key));
  assert.deepEqual(started, ['alpha', 'beta', 'gamma']);
  gates.get('alpha')!.resolve('A');
  gates.get('beta')!.resolve('B');
  gates.get('gamma')!.resolve('C');
  assert.deepEqual(await Promise.all(pending), ['A', 'B', 'C']);
});

test('hidden/key-identity-is-exact-string', async () => {
  const gates = new Map<string, Deferred<string>>([
    ['Key', deferred<string>()],
    ['key', deferred<string>()],
  ]);
  const started: string[] = [];
  const loader = new KeyedLoader<string>((key) => {
    started.push(key);
    return gates.get(key)!.promise;
  });

  const upper = loader.load('Key');
  const lower = loader.load('key');
  assert.deepEqual(started, ['Key', 'key']);
  gates.get('Key')!.resolve('upper');
  gates.get('key')!.resolve('lower');
  assert.deepEqual(await Promise.all([upper, lower]), ['upper', 'lower']);
});

test('hidden/no-retention-growth-across-failures', async () => {
  const failure = new Error('always fails');
  let calls = 0;
  const loader = new KeyedLoader<string>((key) => {
    calls += 1;
    return key === 'healthy' ? Promise.resolve('ok') : Promise.reject(failure);
  });

  for (let index = 0; index < 40; index += 1) {
    await assert.rejects(loader.load(`broken:${index}`), (error: unknown) => error === failure);
  }
  assert.equal(calls, 40);
  assert.equal(loader.size, 0);

  assert.equal(await loader.load('healthy'), 'ok');
  for (let index = 0; index < 20; index += 1) {
    assert.equal(await loader.load('healthy'), 'ok');
  }
  assert.equal(calls, 41);
  assert.equal(loader.size, 1);
});
