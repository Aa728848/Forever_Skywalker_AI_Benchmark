import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyedLoader } from '../starter/src/keyed-loader.ts';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

/** 可控调度：检查自行决定加载何时结算，不使用 sleep 或计时碰撞。 */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onValue, onError) => {
    resolve = onValue;
    reject = onError;
  });
  return { promise, resolve, reject };
}

test('public/same-key-concurrent-single-load', async () => {
  const gate = deferred<string>();
  const calls: string[] = [];
  const loader = new KeyedLoader<string>((key) => {
    calls.push(key);
    return gate.promise;
  });

  const first = loader.load('session');
  const second = loader.load('session');
  const third = loader.load('session');

  assert.deepEqual(calls, ['session']);
  gate.resolve('ready');
  assert.equal(await first, 'ready');
  assert.equal(await second, 'ready');
  assert.equal(await third, 'ready');
  assert.deepEqual(calls, ['session']);
});

test('public/joins-return-same-value', async () => {
  const gate = deferred<{ id: number }>();
  const loader = new KeyedLoader<{ id: number }>(() => gate.promise);

  const first = loader.load('profile');
  const second = loader.load('profile');
  const value = { id: 7 };
  gate.resolve(value);

  assert.ok(Object.is(await first, value));
  assert.ok(Object.is(await second, value));
});

test('public/cached-value-without-source', async () => {
  let calls = 0;
  const loader = new KeyedLoader<number>(async () => {
    calls += 1;
    return calls;
  });

  assert.equal(await loader.load('counter'), 1);
  assert.equal(await loader.load('counter'), 1);
  assert.equal(calls, 1);
  assert.equal(loader.size, 1);
  assert.equal(loader.has('counter'), true);
});

test('public/distinct-keys-load-concurrently', async () => {
  const gates = new Map<string, Deferred<string>>([
    ['left', deferred<string>()],
    ['right', deferred<string>()],
  ]);
  const calls: string[] = [];
  const loader = new KeyedLoader<string>((key) => {
    calls.push(key);
    return gates.get(key)!.promise;
  });

  const left = loader.load('left');
  const right = loader.load('right');

  assert.deepEqual(calls, ['left', 'right']);
  gates.get('left')!.resolve('L');
  gates.get('right')!.resolve('R');
  assert.deepEqual(await Promise.all([left, right]), ['L', 'R']);
});

test('public/failure-rejects-every-caller', async () => {
  const gate = deferred<string>();
  const failure = new Error('upstream unavailable');
  let calls = 0;
  const loader = new KeyedLoader<string>(() => {
    calls += 1;
    return gate.promise;
  });

  const first = loader.load('flaky');
  const second = loader.load('flaky');
  gate.reject(failure);

  await assert.rejects(first, (error: unknown) => error === failure);
  await assert.rejects(second, (error: unknown) => error === failure);
  assert.equal(calls, 1);
});

test('public/retry-after-failure', async () => {
  const failure = new Error('first attempt failed');
  let calls = 0;
  const loader = new KeyedLoader<string>(async () => {
    calls += 1;
    if (calls === 1) throw failure;
    return 'recovered';
  });

  await assert.rejects(loader.load('resource'), (error: unknown) => error === failure);
  assert.equal(loader.has('resource'), false);
  assert.equal(loader.size, 0);
  assert.equal(await loader.load('resource'), 'recovered');
  assert.equal(calls, 2);
});

test('public/sync-throw-becomes-rejection', async () => {
  const failure = new Error('source threw synchronously');
  const loader = new KeyedLoader<string>(() => {
    throw failure;
  });

  const attempt = loader.load('broken');
  await assert.rejects(attempt, (error: unknown) => error === failure);
});

test('public/cache-introspection-api', async () => {
  let calls = 0;
  const loader = new KeyedLoader<number>(async () => {
    calls += 1;
    return calls;
  });

  assert.equal(loader.size, 0);
  assert.equal(loader.has('entry'), false);
  assert.equal(await loader.load('entry'), 1);
  assert.equal(loader.has('entry'), true);
  assert.equal(loader.size, 1);
  assert.equal(loader.delete('entry'), true);
  assert.equal(loader.delete('entry'), false);
  assert.equal(loader.size, 0);
  assert.equal(await loader.load('entry'), 2);
  loader.clear();
  assert.equal(loader.size, 0);
  assert.equal(loader.has('entry'), false);
});
