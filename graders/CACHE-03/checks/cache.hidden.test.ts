import test from 'node:test';
import assert from 'node:assert/strict';
import { VersionedCache, type CachePort } from '../starter/src/cache.ts';

const turn = () => new Promise(resolve => setImmediate(resolve));

/** 手动放行的端口：记录每次 load，并返回可独立结算的句柄。 */
function gatedPort() {
  const gates: Array<{ resolve: (value: string) => void; reject: (error: unknown) => void }> = [];
  const calls: string[] = [];
  const port: CachePort = {
    load(key) {
      calls.push(key);
      return new Promise<string>((resolve, reject) => { gates.push({ resolve, reject }); });
    },
  };
  return { port, calls, gates };
}

test('hidden/hit-returns-the-same-promise-without-reloading', async () => {
  // 契约第 1 条：命中时不得再次 load，直接返回同一个 promise。
  const { port, calls, gates } = gatedPort();
  const cache = new VersionedCache(port);
  const first = cache.get('k');
  assert.deepEqual(calls, ['k'], '首次 get 没有调用 load');
  // 命中：返回同一 promise 引用。
  const second = cache.get('k');
  assert.equal(second, first, '命中返回了不同的 promise');
  assert.deepEqual(calls, ['k'], '命中时又调用了 load');
  gates[0]!.resolve('v1');
  assert.equal(await first, 'v1');
  // 结算后仍是同一代：不再 load。
  const third = cache.get('k');
  assert.deepEqual(calls, ['k'], '结算后又调用了 load');
  assert.equal(await third, 'v1');
  // 多次命中都返回同一个 promise。
  assert.equal(cache.get('k'), third, '命中未复用已保存的 promise');
});

test('hidden/version-starts-at-zero-and-increments-per-invalidate', async () => {
  // 契约第 2 条：版本从 0 开始，每次 invalidate +1。
  const { port, calls, gates } = gatedPort();
  const cache = new VersionedCache(port);
  assert.equal(cache.version('k'), 0, '初始版本不是 0');
  assert.equal(cache.version('never-touched'), 0, '未触碰的 key 版本不是 0');
  // 未失效就 get：版本不变。
  cache.get('k');
  gates[0]!.resolve('v');
  await turn();
  assert.equal(cache.version('k'), 0, 'get 推进了版本');
  // 逐次失效。
  for (let step = 1; step <= 4; step += 1) {
    cache.invalidate('k');
    assert.equal(cache.version('k'), step, '第 ' + step + ' 次失效后版本不对');
  }
  // 不同 key 版本独立。
  cache.invalidate('other');
  assert.equal(cache.version('other'), 1);
  assert.equal(cache.version('k'), 4, '失效 other 影响了 k 的版本');
  assert.deepEqual(calls, ['k'], '失效不该触发 load');
});

test('hidden/stale-inflight-result-still-reaches-its-caller', async () => {
  // 契约第 3 条：在途结果不得复活缓存，但**必须原样返回**给这次调用方。
  const { port, calls, gates } = gatedPort();
  const cache = new VersionedCache(port);
  const stale = cache.get('k');          // 第 0 代
  cache.invalidate('k');
  const fresh = cache.get('k');          // 第 1 代
  assert.deepEqual(calls, ['k', 'k'], '失效后没有重新 load');
  // 旧代先结算：调用方必须拿到它的值。
  gates[0]!.resolve('old');
  assert.equal(await stale, 'old', '旧代调用方没有拿到原样结果');
  // 但它不得占据缓存：随后的 get 必须走第 1 代。
  const again = cache.get('k');
  assert.equal(again, fresh, '旧代结果复活并顶掉了新代在途请求');
  gates[1]!.resolve('new');
  assert.equal(await fresh, 'new');
  assert.equal(await again, 'new', '旧代结果覆盖了新代值');
  await turn();
  assert.equal(await cache.get('k'), 'new', '旧代结果复活成了缓存');
});

test('hidden/only-the-last-generation-may-occupy-the-cache', async () => {
  // 契约第 4 条：多次失效时只有最后发起的那次请求会占据缓存。
  const { port, calls, gates } = gatedPort();
  const cache = new VersionedCache(port);
  const g0 = cache.get('k');
  cache.invalidate('k');
  const g1 = cache.get('k');
  cache.invalidate('k');
  cache.invalidate('k');                   // 第 3 代：连续两次失效
  const g3 = cache.get('k');
  assert.deepEqual(calls.length, 3, 'load 次数不对：' + calls.length);
  // 中间代 (g1) 结算不得占据缓存。
  gates[1]!.resolve('middle');
  assert.equal(await g1, 'middle', '中间代调用方没有拿到结果');
  // 最后代结算后占据缓存。
  gates[2]!.resolve('latest');
  assert.equal(await g3, 'latest');
  await turn();
  assert.equal(await cache.get('k'), 'latest', '缓存不是最后代的值');
  // 最早代迟到也不得改写。
  gates[0]!.resolve('oldest');
  assert.equal(await g0, 'oldest', '最早代调用方没有拿到结果');
  await turn();
  assert.equal(await cache.get('k'), 'latest', '最早代迟到结果复活了');
  assert.equal(cache.version('k'), 3, '版本被回退了');
});

test('hidden/keys-are-independent-and-versions-do-not-leak', async () => {
  // 契约第 5 条：不同 key 互不影响。
  const { port, calls, gates } = gatedPort();
  const cache = new VersionedCache(port);
  const a = cache.get('a');
  const b = cache.get('b');
  const c = cache.get('c');
  assert.deepEqual(calls, ['a', 'b', 'c']);
  // 只失效 b。
  cache.invalidate('b');
  assert.equal(cache.version('a'), 0, '失效 b 推进了 a 的版本');
  assert.equal(cache.version('c'), 0, '失效 b 推进了 c 的版本');
  assert.equal(cache.version('b'), 1);
  // a 与 c 仍然命中（不得重新 load）。
  assert.equal(cache.get('a'), a, 'a 的在途被 b 的失效影响');
  assert.equal(cache.get('c'), c, 'c 的在途被 b 的失效影响');
  // b 必须重新 load。
  const b2 = cache.get('b');
  assert.notEqual(b2, b, 'b 失效后仍返回旧 promise');
  assert.deepEqual(calls, ['a', 'b', 'c', 'b']);
  // 各自结算。
  gates[0]!.resolve('A');
  gates[1]!.resolve('B-old');
  gates[2]!.resolve('C');
  gates[3]!.resolve('B-new');
  assert.deepEqual([await a, await b, await c, await b2], ['A', 'B-old', 'C', 'B-new']);
  await turn();
  assert.equal(await cache.get('a'), 'A');
  assert.equal(await cache.get('b'), 'B-new', 'b 的缓存不是新代值');
  assert.equal(await cache.get('c'), 'C');
});

test('hidden/failed-load-is-not-cached-and-can-be-retried', async () => {
  // 失败不得永久缓存（0.2.0 末段）：显式再调用可重试。
  const { port, calls, gates } = gatedPort();
  const cache = new VersionedCache(port);
  const failing = cache.get('k');
  const error = new Error('加载失败');
  gates[0]!.reject(error);
  await assert.rejects(failing, (thrown: unknown) => thrown === error, '失败没有以原错误拒绝');
  // 失败后缓存不得留下脏值。
  const retry = cache.get('k');
  assert.notEqual(retry, failing, '失败结果被缓存了');
  assert.deepEqual(calls, ['k', 'k'], '重试没有重新 load');
  gates[1]!.resolve('recovered');
  assert.equal(await retry, 'recovered');
  await turn();
  assert.equal(await cache.get('k'), 'recovered');
});
