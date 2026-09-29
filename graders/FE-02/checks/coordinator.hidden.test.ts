import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestCoordinator, SupersededError, type RequestPort } from '../starter/src/coordinator.ts';

interface Call {
  readonly key: string;
  readonly payload: string;
  readonly signal: AbortSignal;
  // 可变：缺陷起始版不结算，测试需要能主动放行这些记录。
  resolve: (value: string) => void;
  reject: (error: unknown) => void;
}

/** 造一条可手动结算的调用记录。 */
function makeCall(key: string, payload: string, signal: AbortSignal): Call {
  const record: Call = {
    key,
    payload,
    signal,
    resolve: () => {},
    reject: () => {},
  };
  return record;
}

function fakePort() {
  const calls: Call[] = [];
  // 每次 send 都先登记 call，再用 impl 决定结算方式：两者必须共用同一条记录。
  let impl: (call: Call) => Promise<string> = call => new Promise<string>((resolve, reject) => {
    call.resolve = value => resolve(value);
    call.reject = error => reject(error);
  });
  const port: RequestPort = {
    send(key, payload, signal) {
      const record = makeCall(key, payload, signal);
      calls.push(record);
      return impl(record);
    },
  };
  return {
    port,
    calls,
    setImpl: (next: (call: Call) => Promise<string>) => { impl = next; },
    abortCount: (index: number): (() => number) => {
      let count = 0;
      calls[index]!.signal.addEventListener('abort', () => { count += 1; });
      return () => count;
    },
  };
}

async function outcomeOf(promise: Promise<string>): Promise<string> {
  try { return 'resolved:' + await promise; }
  catch (error) {
    if (error instanceof SupersededError) return 'superseded:' + error.key;
    return 'other:' + String(error);
  }
}

const flush = () => new Promise(resolve => setImmediate(resolve));

/** 单次结算等待上限（毫秒）。远小于题目 60s 超时，足以区分「慢」与「永不结算」。 */
const SETTLE_TIMEOUT_MS = 2000;

/**
 * 收尾助手：缺陷起始版不会取代也不会结算，断言提前失败会留下永不结算的
 * promise，让 node --test 整个文件挂起（exit=null）并掩盖真正的失败项。
 *
 * 关键：**不能 await 这些 promise**。它们在缺陷版上永远不结算，
 * 等它们就是把测试挂死。这里只做 best-effort 放行，句柄仅用于避免
 * "created promise never awaited" 类诊断，不参与断言。
 */
function settleAll(fake: { calls: Call[] }): void {
  for (const call of fake.calls) call.resolve('cleanup');
}

/**
 * 有限等待：缺陷起始版不取代也不结算，直接 await 会永远挂住整个文件，
 * 让 node --test 以 SIGTERM 收场并只留下第一条失败记录。
 * 这里给每次等待一个上限，超时就返回 'unsettled'，断言照样给出正确信息。
 */
function race<T>(promise: Promise<T>, label: string): Promise<T | string> {
  return Promise.race([
    promise,
    new Promise<string>(resolve => {
      const timer = setTimeout(() => resolve('unsettled:' + label), SETTLE_TIMEOUT_MS);
      // 不 unref：题目禁止真实计时器语义，但这里只是给 await 兜底，超时后必须能正常结束。
      if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') timer.unref();
    }),
  ]);
}

test('hidden/supersede-aborts-old-signal-then-rejects', async () => {
  const fake = fakePort();
  const coordinator = new RequestCoordinator(fake.port);
  const first = coordinator.request('k', 'old');
  const aborts = fake.abortCount(0);
  const second = coordinator.request('k', 'new');
  first.catch(() => {});
  second.catch(() => {});
  // 断言提前失败时也要把端口调用放行，否则未结算的 promise 会让整个文件挂起。
  try {
    // 契约第 1 条：旧 signal 先被 abort。
    assert.equal(aborts(), 1, '取代旧请求时没有 abort 旧 signal');
    assert.equal(await race(outcomeOf(first), 'first'), 'superseded:k');
    // 新请求的 signal 不得被 abort，payload 必须是新值。
    assert.equal(fake.calls[1]!.signal.aborted, false, '取代时误 abort 了新请求的 signal');
    assert.equal(fake.calls[1]!.payload, 'new');
    assert.equal(coordinator.pending, 1);
    fake.calls[1]!.resolve('new');
    assert.equal(await race(second, 'second'), 'new');
    assert.equal(coordinator.pending, 0);
  } finally {
    settleAll(fake);
  }
});

test('hidden/stale-result-can-never-resolve-old-promise', async () => {
  // 端口让旧请求**最后**才返回：过期结果不得兑现到旧 promise。
  const fake = fakePort();
  const coordinator = new RequestCoordinator(fake.port);
  const first = coordinator.request('k', 'old');
  const second = coordinator.request('k', 'new');
  first.catch(() => {});
  second.catch(() => {});
  try {
    assert.equal(await race(outcomeOf(first), 'first'), 'superseded:k');
    // 逆序放行：先放行新请求，再放行旧请求。
    fake.calls[1]!.resolve('new');
    assert.equal(await race(outcomeOf(second), 'second'), 'resolved:new');
    fake.calls[0]!.resolve('old');
    await flush();
    assert.equal(await race(outcomeOf(first), 'first'), 'superseded:k', '过期结果兑现到了旧 promise');
    assert.equal(coordinator.pending, 0);
  } finally {
    settleAll(fake);
  }
});

test('hidden/pending-returns-to-zero-on-every-outcome', async () => {
  for (const scenario of ['success', 'port-error', 'superseded', 'cancelAll'] as const) {
    const fake = fakePort();
    const coordinator = new RequestCoordinator(fake.port);
    assert.equal(coordinator.pending, 0, scenario + '：初始 pending 不为 0');
    // 在创建时就挂上 no-op catch：superseded / cancelAll 会在 await 之前同步拒绝，
    // 只记录不消费仍会被 node:test 判为 unhandledRejection。
    const tracked: Promise<string>[] = [];
    const track = (promise: Promise<string>): Promise<string> => {
      promise.catch(() => {});
      tracked.push(promise);
      return promise;
    };
    const first = track(coordinator.request('a', '1'));
    const second = track(coordinator.request('b', '2'));
    await flush();
    assert.equal(coordinator.pending, 2, scenario + '：发起后 pending 不对');
    if (scenario === 'superseded') {
      // 同 key 再发一次：旧的 a 被取代，新的 a 顶上，pending 仍是 2。
      const third = track(coordinator.request('a', '3'));
      assert.equal(coordinator.pending, 2, 'superseded：取代后 pending 变了');
      // 只放行新的 a 与 b：被取代的旧 a 已结算，不会也不能再兑现。
      fake.calls[1]!.resolve('2');
      fake.calls[2]!.resolve('3');
      assert.equal(await race(third, 'third'), '3');
    } else if (scenario === 'success') {
      fake.calls[0]!.resolve('1');
      fake.calls[1]!.resolve('2');
    } else if (scenario === 'port-error') {
      fake.calls[0]!.reject(new RangeError('端口炸了'));
      fake.calls[1]!.resolve('2');
    } else if (scenario === 'cancelAll') {
      coordinator.cancelAll();
    }
    await race(Promise.allSettled(tracked), 'tracked');
    assert.equal(coordinator.pending, 0, scenario + '：结算后 pending 未归零');
  }
});

test('hidden/port-error-does-not-poison-later-requests', async () => {
  const fake = fakePort();
  const coordinator = new RequestCoordinator(fake.port);
  const first = coordinator.request('k', 'x');
  await flush();
  try {
    fake.calls[0]!.reject(new RangeError('第一次失败'));
    assert.equal(await race(outcomeOf(first), 'first'), 'other:RangeError: 第一次失败');
    assert.equal(coordinator.pending, 0, '失败后 pending 未归零');
    const second = coordinator.request('k', 'y');
    await flush();
    fake.calls[1]!.resolve('y');
    assert.equal(await race(outcomeOf(second), 'second'), 'resolved:y');
    const throwing = new RequestCoordinator({ send() { throw new Error('同步抛'); } });
    assert.equal(await race(outcomeOf(throwing.request('k', 'z')), 'z'), 'other:Error: 同步抛');
    assert.equal(throwing.pending, 0);
  } finally {
    settleAll(fake);
  }
});

test('hidden/cancelAll-aborts-everything-with-superseded-error', async () => {
  const fake = fakePort();
  const coordinator = new RequestCoordinator(fake.port);
  const a = coordinator.request('a', '1');
  const b = coordinator.request('b', '2');
  a.catch(() => {}); b.catch(() => {});
  const abortA = fake.abortCount(0);
  const abortB = fake.abortCount(1);
  await flush();
  try {
    assert.equal(coordinator.pending, 2);
    coordinator.cancelAll();
    assert.equal(abortA(), 1, 'cancelAll 没有 abort 第一个 signal');
    assert.equal(abortB(), 1, 'cancelAll 没有 abort 第二个 signal');
    // 契约第 5 条：用 SupersededError 而不是普通 Error。
    assert.equal(await race(outcomeOf(a), 'a'), 'superseded:a');
    assert.equal(await race(outcomeOf(b), 'b'), 'superseded:b');
    assert.equal(coordinator.pending, 0);
    // 空状态下调用必须安全。
    coordinator.cancelAll();
    assert.equal(coordinator.pending, 0);
  } finally {
    settleAll(fake);
  }
});

test('hidden/late-settlements-after-cancelAll-are-ignored', async () => {
  const fake = fakePort();
  const coordinator = new RequestCoordinator(fake.port);
  const a = coordinator.request('a', '1');
  const b = coordinator.request('b', '2');
  a.catch(() => {}); b.catch(() => {});
  await flush();
  const settled = Promise.allSettled([a, b]);
  try {
    coordinator.cancelAll();
    await race(settled, 'settled');
    assert.equal(await race(outcomeOf(a), 'a'), 'superseded:a');
    // 端口在取消后才兑现：不得改写已结算的 promise。
    fake.calls[0]!.resolve('迟到的 a');
    fake.calls[1]!.resolve('迟到的 b');
    await flush();
    assert.equal(await race(outcomeOf(a), 'a'), 'superseded:a', '迟到的 a 改写了已结算的 promise');
    assert.equal(await race(outcomeOf(b), 'b'), 'superseded:b', '迟到的 b 改写了已结算的 promise');
    assert.equal(coordinator.pending, 0, '迟到结算让 pending 反弹');
  } finally {
    settleAll(fake);
  }
});

test('hidden/three-rounds-of-supersede-keep-exactly-one-live', async () => {
  const fake = fakePort();
  const coordinator = new RequestCoordinator(fake.port);
  const promises = ['v1', 'v2', 'v3'].map(payload => coordinator.request('k', payload));
  // 前两个在第三次 request 时就被拒绝：先挂上处理器。
  promises.forEach(promise => promise.catch(() => {}));
  await flush();
  // 无论如何都要把端口的三个调用都放行，否则断言提前失败会留下悬挂 promise。
  try {
    // 三次取代后只有最后一次还挂起。
    assert.equal(coordinator.pending, 1, '连续取代后 pending 不是 1');
    assert.equal(await race(outcomeOf(promises[0]!), 'p0'), 'superseded:k');
    assert.equal(await race(outcomeOf(promises[1]!), 'p1'), 'superseded:k');
    fake.calls[2]!.resolve('v3');
    assert.equal(await race(outcomeOf(promises[2]!), 'p2'), 'resolved:v3');
    assert.equal(coordinator.pending, 0);
  } finally {
    settleAll(fake);
  }
  // 两次迟到的旧结果都不得改写。
  fake.calls[0]!.resolve('v1');
  fake.calls[1]!.resolve('v2');
  await flush();
  assert.equal(await race(outcomeOf(promises[0]!), 'p0-late'), 'superseded:k');
  assert.equal(await race(outcomeOf(promises[1]!), 'p1-late'), 'superseded:k');
});

test('hidden/signals-are-distinct-per-request-and-never-shared', async () => {
  const fake = fakePort();
  fake.setImpl(call => Promise.resolve(call.payload));
  const coordinator = new RequestCoordinator(fake.port);
  const a = coordinator.request('a', '1');
  const b = coordinator.request('b', '2');
  const c = coordinator.request('a', '3');
  a.catch(() => {}); b.catch(() => {}); c.catch(() => {});
  try {
    await race(Promise.allSettled([a, b, c]), 'abc');
    assert.equal(fake.calls.length, 3);
    const signals = fake.calls.map(call => call.signal);
    assert.equal(new Set(signals).size, 3, '不同请求共用了同一个 AbortSignal');
    // 已被取代的第一个 signal 是 aborted 的，后两个不是。
    assert.equal(signals[0]!.aborted, true);
    assert.equal(signals[1]!.aborted, false);
    assert.equal(signals[2]!.aborted, false);
    assert.equal(coordinator.pending, 0);
  } finally {
    settleAll(fake);
  }
});

test('hidden/three-keys-interleave-without-cross-talk', async () => {
  const fake = fakePort();
  const coordinator = new RequestCoordinator(fake.port);
  const a = coordinator.request('a', 'ra');
  const b = coordinator.request('b', 'rb');
  const c = coordinator.request('c', 'rc');
  a.catch(() => {}); b.catch(() => {}); c.catch(() => {});
  await flush();
  try {
    assert.equal(coordinator.pending, 3);
    // 打乱完成顺序：c、a、b。
    fake.calls[2]!.resolve('RC');
    assert.equal(await race(outcomeOf(c), 'c'), 'resolved:RC');
    assert.equal(coordinator.pending, 2);
    fake.calls[0]!.resolve('RA');
    assert.equal(await race(outcomeOf(a), 'a'), 'resolved:RA');
    fake.calls[1]!.resolve('RB');
    assert.equal(await race(outcomeOf(b), 'b'), 'resolved:RB');
    assert.equal(coordinator.pending, 0);
  } finally {
    settleAll(fake);
  }
  // 取消后立刻可以重新发起。
  const other = fakePort();
  const coordinator2 = new RequestCoordinator(other.port);
  const x = coordinator2.request('x', '1');
  const y = coordinator2.request('y', '2');
  x.catch(() => {}); y.catch(() => {});
  await flush();
  try {
    const cancelled = Promise.allSettled([x, y]);
    coordinator2.cancelAll();
    await race(cancelled, 'cancelled');
    assert.equal(await race(outcomeOf(x), 'x'), 'superseded:x');
    assert.equal(await race(outcomeOf(y), 'y'), 'superseded:y');
    const z = coordinator2.request('z', '3');
    await flush();
    other.calls[2]!.resolve('3');
    assert.equal(await race(outcomeOf(z), 'z'), 'resolved:3');
  } finally {
    settleAll(other);
  }
});
