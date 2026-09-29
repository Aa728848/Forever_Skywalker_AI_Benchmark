import test from 'node:test';
import assert from 'node:assert/strict';
import { AdapterError, Repository, type AdapterV2, type LegacyAdapter } from '../starter/src/repository.ts';

const legacy = (result: { ok: boolean; ms: number; payload?: string }): LegacyAdapter =>
  ({ fetch: () => result });
const v2 = (result: { status: 'ok' | 'missing'; durationSeconds: number; body: string | null }): AdapterV2 =>
  ({ load: async () => result });

test('hidden/v2-missing-is-not-an-error-and-has-null-body', () => {
  // 契约第 2 条：missing 时 ok=false、body=null，**不是错误**。
  for (const repository of [
    new Repository(v2({ status: 'missing', durationSeconds: 1.5, body: 'should be dropped' })),
    new Repository(v2({ status: 'missing', durationSeconds: 0, body: null })),
  ]) {
    // 不得抛错：必须正常兑现。
    return repository.read('k').then(result => {
      assert.equal(result.ok, false, 'missing 被当成成功');
      assert.equal(result.body, null, 'missing 的 body 没有归 null');
      // 时长仍按秒转毫秒。
      assert.equal(typeof result.durationMs, 'number');
    });
  }
});

test('hidden/seconds-to-milliseconds-is-exact', async () => {
  // 契约第 1 条：durationMs = durationSeconds × 1000。
  // 关键反例：1.5 秒必须是 1500 毫秒，直接透传只会得到 1.5。
  const cases: Array<[number, number]> = [[1, 1000], [1.5, 1500], [0.001, 1], [0, 0], [2.5, 2500], [10, 10000], [0.25, 250]];
  for (const [seconds, expected] of cases) {
    const result = await new Repository(v2({ status: 'ok', durationSeconds: seconds, body: 'x' })).read('k');
    assert.equal(result.durationMs, expected, 'durationSeconds=' + seconds);
    assert.equal(result.ok, true);
    assert.equal(result.body, 'x');
  }
});

test('hidden/legacy-and-v2-produce-identical-semantics', () => {
  // 契约第 1 条：两个适配器必须给出语义一致的 ReadResult。
  return Promise.all([
    // 旧：ok=true、ms=1500、payload='body'。
    new Repository(legacy({ ok: true, ms: 1500, payload: 'body' })).read('k'),
    // 新：status='ok'、durationSeconds=1.5、body='body'。
    new Repository(v2({ status: 'ok', durationSeconds: 1.5, body: 'body' })).read('k'),
  ]).then(([fromLegacy, fromV2]) => {
    assert.deepEqual(fromV2, fromLegacy, '两个适配器的语义不一致');
    assert.deepEqual(fromV2, { ok: true, durationMs: 1500, body: 'body' });
  });
});

test('hidden/legacy-missing-payload-becomes-null', () => {
  // 契约第 1 条：body 取 payload ?? null。undefined 必须归 null。
  return Promise.all([
    new Repository(legacy({ ok: true, ms: 0, payload: undefined })).read('k'),
    new Repository(legacy({ ok: false, ms: 10 })).read('k'),
    new Repository(legacy({ ok: true, ms: 0, payload: '' })).read('k'),
  ]).then(([withoutPayload, missing, empty]) => {
    assert.equal(withoutPayload.body, null, 'undefined payload 没有归 null');
    assert.equal(missing.body, null);
    assert.equal(missing.ok, false, 'ok=false 被改成了 true');
    // 空字符串是合法值，不能被归成 null。
    assert.equal(empty.body, '', '空字符串被当成了缺失');
  });
});

test('hidden/sync-and-async-failures-both-wrap', () => {
  // 契约第 3 条：同步或异步抛错统一包成 AdapterError，不得泄漏原始错误。
  const raw = new Error('原始故障');
  return Promise.all([
    // 旧适配器同步抛。
    new Repository({ fetch: () => { throw raw; } }).read('k1').then(
      () => { throw new Error('旧适配器同步抛错没有被拒绝'); },
      (error: unknown) => {
        assert.ok(error instanceof AdapterError, '不是 AdapterError：' + String(error));
        assert.equal((error as AdapterError).id, 'k1', 'id 不是请求的 id');
        assert.equal(error instanceof Error && error.message.includes('原始故障'), true, '原始错误信息未保留');
      },
    ),
    // 新适配器异步拒。
    new Repository({ load: () => Promise.reject(raw) }).read('k2').then(
      () => { throw new Error('新适配器异步拒没有被拒绝'); },
      (error: unknown) => {
        assert.ok(error instanceof AdapterError, '不是 AdapterError：' + String(error));
        assert.equal((error as AdapterError).id, 'k2');
      },
    ),
    // 新适配器同步抛。
    new Repository({ load: () => { throw raw; } }).read('k3').then(
      () => { throw new Error('新适配器同步抛没有被拒绝'); },
      (error: unknown) => {
        assert.ok(error instanceof AdapterError, '不是 AdapterError：' + String(error));
        assert.equal((error as AdapterError).id, 'k3');
      },
    ),
  ]);
});

test('hidden/adapter-object-is-never-mutated', () => {
  // 契约第 4 条：不得修改适配器对象。
  const oldAdapter: LegacyAdapter = { fetch: () => ({ ok: true, ms: 1, payload: 'p' }) };
  const before = Object.keys(oldAdapter).sort();
  const newAdapter: AdapterV2 = { load: async () => ({ status: 'ok', durationSeconds: 1, body: 'p' }) };
  const beforeNew = Object.keys(newAdapter).sort();
  return Promise.all([
    new Repository(oldAdapter).read('a'),
    new Repository(newAdapter).read('b'),
  ]).then(() => {
    assert.deepEqual(Object.keys(oldAdapter).sort(), before, '旧适配器被加了字段');
    assert.deepEqual(Object.keys(newAdapter).sort(), beforeNew, '新适配器被加了字段');
    // 结果也不得把适配器内部字段暴露出去。
    return new Repository(newAdapter).read('c');
  }).then(result => {
    assert.deepEqual(Object.keys(result).sort(), ['body', 'durationMs', 'ok'],
      '结果里混入了适配器内部字段');
  });
});

test('hidden/repeated-reads-are-independent', () => {
  // 多次读取不得缓存或串台。
  let call = 0;
  const repository = new Repository({ load: async () => ({ status: 'ok' as const, durationSeconds: ++call, body: 'b' + call }) });
  return Promise.all([
    repository.read('k'),
    repository.read('k'),
    repository.read('k'),
  ]).then(([first, second, third]) => {
    const durations = [first.durationMs, second.durationMs, third.durationMs].sort((a, b) => a - b);
    // durationSeconds 是 1/2/3 秒，按契约换算成毫秒是 1000/2000/3000。
    assert.deepEqual(durations, [1000, 2000, 3000], '多次读取被缓存或串台了：' + JSON.stringify(durations));
    assert.equal(call, 3, 'load 被调用了 ' + call + ' 次');
  });
});
