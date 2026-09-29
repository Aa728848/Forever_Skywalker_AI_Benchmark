import test from 'node:test';
import assert from 'node:assert/strict';
import { Supervisor, type Runner } from '../starter/src/supervisor.ts';

// 实现可能把控制串行化在 Promise 队列上，phase 切换要经过若干轮微任务；
// 用 setImmediate 统一让出，比单次微任务更贴合实际调度。
const flush = () => new Promise(resolve => setImmediate(resolve));

/** 可手动控制结算的 runner：记录每次 run 的 signal 与结算句柄。 */
function controllableRunner() {
  const calls: Array<{ signal: AbortSignal; settle: () => void; fail: (error: unknown) => void }> = [];
  const runner: Runner = {
    run(signal) {
      return new Promise<void>((resolve, reject) => {
        calls.push({ signal, settle: resolve, fail: reject });
      });
    },
  };
  return { runner, calls };
}

test('hidden/start-while-stopping-defers-and-is-not-dropped', async () => {
  // 契约第 3 条：stop 未完成时的 start 必须等停止完成，且不得被丢弃。
  const { runner, calls } = controllableRunner();
  const supervisor = new Supervisor(runner);
  await supervisor.start();
  assert.equal(calls.length, 1);
  assert.equal(supervisor.phase, 'running');
  assert.equal(supervisor.startCount, 1);

  const stopping = supervisor.stop();
  await flush();
  // 旧 runner 尚未结算：此时 phase 必须是 stopping。
  // 实现可以是同步切换或经一个微任务切换，契约只要求与语义一致。
  assert.equal(supervisor.phase, 'stopping', '停止期间 phase 不是 stopping');
  // 旧 signal 必须已 abort。
  assert.equal(calls[0]!.signal.aborted, true, 'stop 没有 abort 当前 signal');

  const restarting = supervisor.start();
  await flush();
  // 旧代际未结算前，**不得**并发启动新 runner。
  assert.equal(calls.length, 1, '停止未完成就启动了新 runner');
  assert.equal(supervisor.startCount, 1, 'startCount 提前增加了');

  calls[0]!.settle();
  await stopping;
  await restarting.catch(() => undefined);
  // 停止完成后这次 start 必须真正执行。
  assert.equal(calls.length, 2, '延后的 start 没有执行');
  assert.equal(supervisor.startCount, 2, '延后的 start 被丢弃了');
  // 新 runner 必须拿到全新的、未中止的 signal。
  assert.notEqual(calls[1]!.signal, calls[0]!.signal, '复用了旧 signal');
  assert.equal(calls[1]!.signal.aborted, false, '新 runner 拿到已中止的 signal');
  assert.equal(supervisor.phase, 'running');
});

test('hidden/multiple-starts-during-stop-merge-into-one', async () => {
  // 0.2.0 末段：任意多个 start 等待同一旧代际，合并成一次新启动。
  const { runner, calls } = controllableRunner();
  const supervisor = new Supervisor(runner);
  await supervisor.start();
  const stopping = supervisor.stop();
  const a = supervisor.start();
  const b = supervisor.start();
  const c = supervisor.start();
  await flush();
  assert.equal(calls.length, 1, '停止未完成时启动了新 runner');
  calls[0]!.settle();
  await Promise.all([stopping, a, b, c]);
  // 三次 start 合并成**一次**新启动。
  assert.equal(calls.length, 2, '三个 start 没有合并成一次');
  assert.equal(supervisor.startCount, 2, 'startCount 不是 2');
  assert.equal(supervisor.phase, 'running');
});

test('hidden/old-generation-settlement-cannot-clear-new-state', async () => {
  // 0.2.0 末段：旧代际的结算不得清除新状态。
  const { runner, calls } = controllableRunner();
  const supervisor = new Supervisor(runner);
  await supervisor.start();
  const stopping = supervisor.stop();
  const restarting = supervisor.start();
  // 实现可把 start 排在 stop 之后（队列），此时 phase 尚未切换是合法的。
  // 关键不变量是：旧代际未结算前不得并发启动新 runner。
  await flush();
  await flush();
  assert.equal(calls.length, 1, '停止未完成就启动了新 runner');
  // 让新代际启动，再让旧代际迟到结算。
  calls[0]!.settle();
  await stopping;
  await restarting.catch(() => undefined);
  assert.equal(calls.length, 2);
  // 新代际已启动且未被旧代际的结算清除：phase 必须仍在进行中，不是 idle。
  await flush();
  assert.notEqual(supervisor.phase, 'idle', '旧代际结算把新状态清成了 idle');
  assert.equal(supervisor.startCount, 2);
  // 再 stop 一次必须能正常结束新代际。
  const stopping2 = supervisor.stop();
  await flush();
  assert.equal(supervisor.phase, 'stopping', '第二次停止期间 phase 不是 stopping');
  calls[1]!.settle();
  await stopping2;
  assert.equal(supervisor.phase, 'idle');
});

test('hidden/sync-throwing-runner-rejects-start-and-returns-to-idle', async () => {
  // 0.2.0 末段：同步抛错必须使 start 以同一错误拒绝并回到 idle；
  // startCount 统计实际 run 调用次数（含失败启动）。
  const failure = new Error('run 同步抛错');
  const supervisor = new Supervisor({ run() { throw failure; } });
  await assert.rejects(async () => supervisor.start(), (error: unknown) => error === failure, '没有以同一错误拒绝');
  assert.equal(supervisor.phase, 'idle', '同步抛错后没有回到 idle');
  assert.equal(supervisor.startCount, 1, '失败的启动没有计入 startCount');
  // 失败后还能重新启动（用一个不会立即结算的 runner 观察 running）。
  const { runner, calls } = controllableRunner();
  const recovered = new Supervisor(runner);
  await recovered.start();
  assert.equal(recovered.phase, 'running', '失败后无法重新启动');
  assert.equal(recovered.startCount, 1);
  const stopping = recovered.stop();
  calls[0]!.settle();
  await stopping;
  assert.equal(recovered.phase, 'idle');
});

test('hidden/repeated-start-in-running-is-idempotent', async () => {
  // 契约第 1 条：running/starting 时 start 幂等，不重复调用 runner。
  const { runner, calls } = controllableRunner();
  const supervisor = new Supervisor(runner);
  await supervisor.start();
  await supervisor.start();
  await supervisor.start();
  assert.equal(calls.length, 1, '重复 start 启动了多个 runner');
  assert.equal(supervisor.startCount, 1, '重复 start 增加了 startCount');
  assert.equal(supervisor.phase, 'running');
});

test('hidden/repeated-stop-shares-one-process', async () => {
  // 契约第 2 条：重复 stop 幂等且共用同一次停止过程。
  const { runner, calls } = controllableRunner();
  const supervisor = new Supervisor(runner);
  await supervisor.start();
  const a = supervisor.stop();
  const b = supervisor.stop();
  const c = supervisor.stop();
  await flush();
  // 旧 runner 只被结算一次，三次 stop 等同一次。
  calls[0]!.settle();
  await Promise.all([a, b, c]);
  assert.equal(supervisor.phase, 'idle');
  assert.equal(supervisor.startCount, 1);
  // 幂等 stop 不应 abort 任何新 signal。
  assert.equal(calls[0]!.signal.aborted, true);
});

test('hidden/stop-waits-for-real-settlement-not-just-abort', async () => {
  // 0.2.0 末段：stop 等待真实运行 promise 结算，不能仅凭 abort 就算释放。
  const { runner, calls } = controllableRunner();
  const supervisor = new Supervisor(runner);
  await supervisor.start();
  let stopped = false;
  const stopping = supervisor.stop().then(() => { stopped = true; });
  await flush();
  assert.equal(calls[0]!.signal.aborted, true, 'stop 没有 abort');
  // abort 已发生但运行未结算：stop 不得完成。
  assert.equal(stopped, false, '仅凭 abort 就认为资源已释放');
  assert.equal(supervisor.phase, 'stopping');
  calls[0]!.settle();
  await stopping;
  assert.equal(stopped, true);
  assert.equal(supervisor.phase, 'idle');
});

test('hidden/async-runner-failure-does-not-disturb-settled-start', async () => {
  // 0.2.0 末段：异步运行异常不回头改变已结算的 start，stop 仍可完成。
  const { runner, calls } = controllableRunner();
  const supervisor = new Supervisor(runner);
  await supervisor.start();
  assert.equal(supervisor.phase, 'running');
  // 运行在 start 结算之后才异常。
  calls[0]!.fail(new Error('异步失败'));
  await flush();
  assert.equal(supervisor.startCount, 1, '异步失败改写了已结算的 start');
  // stop 仍可完成。
  const stopping = supervisor.stop();
  await flush();
  calls[0]!.fail(new Error('再次失败'));
  await stopping;
  assert.equal(supervisor.phase, 'idle');
});

test('hidden/phase-transitions-are-observable-and-legal', async () => {
  // 契约第 4 条：phase 任一时刻只取四个合法值，且与语义一致。
  const { runner, calls } = controllableRunner();
  const supervisor = new Supervisor(runner);
  const legal = new Set(['idle', 'starting', 'running', 'stopping']);
  const observe = () => { assert.equal(legal.has(supervisor.phase), true, '非法 phase：' + supervisor.phase); };
  observe();
  assert.equal(supervisor.phase, 'idle', '初始应为 idle');
  const starting = supervisor.start();
  observe();
  await starting;
  observe();
  assert.equal(supervisor.phase, 'running');
  const stopping = supervisor.stop();
  await flush();
  observe();
  assert.equal(supervisor.phase, 'stopping', '停止期间不是 stopping');
  calls[0]!.settle();
  await stopping;
  observe();
  assert.equal(supervisor.phase, 'idle', '停止完成后不是 idle');
});
