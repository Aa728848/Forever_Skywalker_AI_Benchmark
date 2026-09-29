import test from 'node:test';
import assert from 'node:assert/strict';
import { CancelledError, TimeoutError, runCancelable, type Scheduler, type TimerHandle } from '../starter/src/cancelable.ts';

/** 可观测调度器：记录每次 after 的参数、句柄与取消次数，并能按需触发。 */
function fakeScheduler() {
  const timers: Array<{ delayMs: number; run: () => void; cancelCount: number; handle: TimerHandle }> = [];
  const scheduler: Scheduler = {
    after(delayMs, run) {
      const record = { delayMs, run, cancelCount: 0, handle: null as unknown as TimerHandle };
      const handle: TimerHandle = { cancel() { record.cancelCount += 1; } };
      record.handle = handle;
      timers.push(record);
      return handle;
    },
  };
  return {
    scheduler,
    timers,
    live: () => timers.filter(timer => timer.cancelCount === 0),
    cancels: () => timers.reduce((sum, timer) => sum + timer.cancelCount, 0),
    fireAll: () => { for (const timer of [...timers]) timer.run(); },
    fireLast: () => { const timer = timers[timers.length - 1]; if (timer) timer.run(); },
  };
}

async function settleOf(promise: Promise<unknown>): Promise<string> {
  try { const value = await promise; return 'resolved:' + String(value); }
  catch (error) {
    if (error instanceof CancelledError) return 'cancelled';
    if (error instanceof TimeoutError) return 'timeout';
    return 'other:' + String(error);
  }
}

const pending = () => new Promise<never>(() => {});

test('hidden/work-receives-fresh-non-aborted-signal', async () => {
  const fake = fakeScheduler();
  const state: { signal: AbortSignal | null } = { signal: null };
  const task = runCancelable(signal => { state.signal = signal; return Promise.resolve('ok'); }, { scheduler: fake.scheduler });
  // 工作必须在调用时就能拿到一个尚未 abort 的 signal。
  assert.ok(state.signal, '工作没有被传入 signal');
  assert.equal(state.signal!.aborted, false);
  assert.equal(await settleOf(task.promise), 'resolved:ok');
  // 成功结算后 signal 不得被 abort：契约只要求取消/超时时 abort。
  assert.equal(state.signal!.aborted, false, '成功结算后不应 abort signal');
});

test('hidden/sync-throw-does-not-escape-and-clears-timer', async () => {
  const fake = fakeScheduler();
  const boom = new TypeError('同步炸了');
  let task!: ReturnType<typeof runCancelable>;
  // 契约：同步抛出绝不能冒到调用方。
  assert.doesNotThrow(() => {
    task = runCancelable(() => { throw boom; }, { scheduler: fake.scheduler });
  });
  assert.equal(await settleOf(task.promise), 'other:TypeError: 同步炸了');
  assert.equal(fake.live().length, 0, '同步失败后定时器必须被取消');
  assert.equal(fake.cancels(), 1);
});

test('hidden/cancel-aborts-before-rejecting', async () => {
  const fake = fakeScheduler();
  const order: string[] = [];
  const state: { signal: AbortSignal | null } = { signal: null };
  const task = runCancelable(signal => {
    state.signal = signal;
    signal.addEventListener('abort', () => order.push('abort'));
    return pending();
  }, { scheduler: fake.scheduler });
  task.cancel();
  // 契约第 2 条：先 abort，再拒绝。abort 监听器必须先于拒绝被观察到。
  assert.equal(state.signal!.aborted, true);
  assert.deepEqual(order, ['abort'], 'abort 事件没有在结算前触发');
  assert.equal(await settleOf(task.promise), 'cancelled');
  // 取消也必须清掉定时器。
  assert.equal(fake.live().length, 0, '取消后定时器仍存活');
  assert.equal(fake.cancels(), 1);
  // 之后再触发超时不得改变结果。
  fake.fireAll();
  assert.equal(await settleOf(task.promise), 'cancelled');
});

test('hidden/repeated-cancel-is-idempotent', async () => {
  const fake = fakeScheduler();
  let abortCount = 0;
  const state: { signal: AbortSignal | null } = { signal: null };
  const task = runCancelable(signal => {
    state.signal = signal;
    signal.addEventListener('abort', () => { abortCount += 1; });
    return pending();
  }, { scheduler: fake.scheduler });
  for (let i = 0; i < 5; i += 1) task.cancel();
  assert.equal(abortCount, 1, '重复 cancel 重复 abort 了 signal');
  assert.equal(await settleOf(task.promise), 'cancelled');
  // TimerHandle.cancel 也只应被调用一次。
  assert.equal(fake.cancels(), 1, '定时器被重复取消');
});

test('hidden/timeout-aborts-then-rejects-and-is-final', async () => {
  const fake = fakeScheduler();
  const order: string[] = [];
  const state: { signal: AbortSignal | null } = { signal: null };
  const task = runCancelable(signal => {
    state.signal = signal;
    signal.addEventListener('abort', () => order.push('abort'));
    return pending();
  }, { scheduler: fake.scheduler, timeoutMs: 50 });
  assert.equal(fake.timers.length, 1);
  assert.equal(fake.timers[0]!.delayMs, 50);
  assert.equal(state.signal!.aborted, false, '超时前 signal 不应已 abort');
  fake.fireAll();
  // 契约第 3 条：先 abort，再以 TimeoutError 拒绝。
  assert.deepEqual(order, ['abort'], '超时没有先 abort signal');
  assert.equal(await settleOf(task.promise), 'timeout');
  // 超时结算后不得再 abort。
  const abortsAfter = state.signal!.aborted;
  task.cancel();
  assert.equal(state.signal!.aborted, abortsAfter);
  assert.equal(await settleOf(task.promise), 'timeout', '超时后再 cancel 改变了结果');
  assert.equal(fake.live().length, 0, '超时后定时器仍存活');
});

test('hidden/default-timeout-is-30000-and-explicit-zero-is-honored', async () => {
  const fake = fakeScheduler();
  const defaulted = runCancelable(() => pending(), { scheduler: fake.scheduler });
  assert.equal(fake.timers[0]!.delayMs, 30000, '缺省超时不是 30000');
  // 必须接住这次结算，否则测试结束后的未处理拒绝会让整个文件判失败。
  fake.timers[0]!.run();
  assert.equal(await settleOf(defaulted.promise), 'timeout');
  // 显式 0：立即到期也是合法配置。
  const zero = fakeScheduler();
  const state: { signal: AbortSignal | null } = { signal: null };
  const task = runCancelable(signal => { state.signal = signal; return pending(); }, { scheduler: zero.scheduler, timeoutMs: 0 });
  assert.equal(zero.timers[0]!.delayMs, 0);
  zero.fireAll();
  assert.equal(state.signal!.aborted, true);
  assert.equal(await settleOf(task.promise), 'timeout');
});

test('hidden/timer-cancelled-exactly-once-on-every-outcome', async () => {
  for (const scenario of ['success', 'work-error', 'cancel', 'timeout'] as const) {
    const fake = fakeScheduler();
    const task = scenario === 'success'
      ? runCancelable(() => Promise.resolve(1), { scheduler: fake.scheduler })
      : scenario === 'work-error'
        ? runCancelable(() => Promise.reject(new Error('e')), { scheduler: fake.scheduler })
        : scenario === 'cancel'
          ? runCancelable(() => pending(), { scheduler: fake.scheduler })
          : runCancelable(() => pending(), { scheduler: fake.scheduler, timeoutMs: 10 });
    if (scenario === 'cancel') task.cancel();
    if (scenario === 'timeout') fake.fireAll();
    const outcome = await settleOf(task.promise);
    assert.notEqual(outcome, 'resolved:undefined');
    assert.equal(fake.timers.length, 1, scenario + '：调度器被调用了多次');
    assert.equal(fake.cancels(), 1, scenario + '：TimerHandle.cancel 调用次数不是 1');
    assert.equal(fake.live().length, 0, scenario + '：仍有存活定时器');
  }
});

test('hidden/late-work-settlement-cannot-change-result', async () => {
  const fake = fakeScheduler();
  let release!: (value: string) => void;
  const task = runCancelable(() => new Promise<string>(resolve => { release = resolve; }), { scheduler: fake.scheduler });
  task.cancel();
  assert.equal(await settleOf(task.promise), 'cancelled');
  // 工作在取消之后才完成：结果必须仍是 cancelled，不得被改写。
  release('迟到的结果');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await settleOf(task.promise), 'cancelled', '迟到的工作结果改写了已结算的 promise');
  // 同理：超时后迟到完成也不得改写。
  const other = fakeScheduler();
  let releaseOther!: (value: string) => void;
  const timedOut = runCancelable(() => new Promise<string>(resolve => { releaseOther = resolve; }), { scheduler: other.scheduler, timeoutMs: 5 });
  other.fireAll();
  assert.equal(await settleOf(timedOut.promise), 'timeout');
  releaseOther('also late');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await settleOf(timedOut.promise), 'timeout', '迟到的工作结果改写了已超时的 promise');
});

test('hidden/independent-tasks-do-not-share-timers-or-signals', async () => {
  const fake = fakeScheduler();
  const signals: AbortSignal[] = [];
  const tasks = [0, 1, 2].map(index => runCancelable(signal => {
    signals.push(signal);
    return pending();
  }, { scheduler: fake.scheduler, timeoutMs: 100 + index }));
  assert.equal(fake.timers.length, 3, '三个任务必须各自注册一个定时器');
  assert.deepEqual(fake.timers.map(timer => timer.delayMs), [100, 101, 102]);
  assert.equal(new Set(signals).size, 3, '三个任务共用了同一个 signal');
  // 取消中间一个，另外两个必须不受影响。
  tasks[1]!.cancel();
  assert.equal(await settleOf(tasks[1]!.promise), 'cancelled');
  assert.equal(signals[0]!.aborted, false, '取消 B 却 abort 了 A 的 signal');
  assert.equal(signals[2]!.aborted, false, '取消 B 却 abort 了 C 的 signal');
  // 只剩两个存活定时器，触发后其余两个各自超时。
  assert.equal(fake.live().length, 2);
  fake.fireAll();
  assert.equal(await settleOf(tasks[0]!.promise), 'timeout');
  assert.equal(await settleOf(tasks[2]!.promise), 'timeout');
  assert.equal(fake.live().length, 0);
});
