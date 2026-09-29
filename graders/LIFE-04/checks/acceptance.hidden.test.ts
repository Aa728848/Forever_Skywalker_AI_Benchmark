import test from 'node:test';
import assert from 'node:assert/strict';
import { AcceptanceRunner, BusyError, classify, type ChildHandle, type ChildPort } from '../starter/src/acceptance.ts';

/** 手动控制退出的子进程端口：记录 spawn、kill 与退出回调。 */
function fakePort() {
  const spawned: Array<{ pid: number; killCount: number; emit: (code: number | null, signal: string | null) => void; killed: boolean }> = [];
  let nextPid = 1000;
  const port: ChildPort = {
    spawn() {
      const pid = nextPid++;
      const record = { pid, killCount: 0, killed: false, emit: (_code: number | null, _signal: string | null) => {} };
      spawned.push(record);
      const handle: ChildHandle = {
        pid,
        kill() { record.killCount += 1; record.killed = true; },
        onExit(listener) { record.emit = listener; },
      };
      return handle;
    },
  };
  return { port, spawned };
}

/**
 * 有界等待：缺陷起始版不拒绝重入，会把验收留在 busy 并让后续断言永不结算，
 * 从而以 exit=null 掩盖真正的失败项。给每次等待一个上限，超时即视为失败。
 */
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待超时：' + label)), 2000);
      if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') timer.unref();
    }),
  ]);
}

test('hidden/classify-covers-every-exit-shape', () => {
  // 契约第 1 条：code===0 为 exited；带 signal 为 killed；其余为 crashed。
  assert.equal(classify(0, null), 'exited');
  assert.equal(classify(1, null), 'crashed');
  assert.equal(classify(2, null), 'crashed');
  assert.equal(classify(255, null), 'crashed');
  // signal 非 null 优先于 code：带信号一律 killed。
  assert.equal(classify(0, 'SIGTERM'), 'killed', 'code=0 且带 signal 的分类不对');
  assert.equal(classify(1, 'SIGKILL'), 'killed');
  assert.equal(classify(null, 'SIGSEGV'), 'killed');
  assert.equal(classify(null, 'SIGABRT'), 'killed');
  // null/null 是崩溃，不是正常退出。
  assert.equal(classify(null, null), 'crashed');
  // 负数退出码仍是 crashed。
  assert.equal(classify(-1, null), 'crashed');
});

test('hidden/accept-resolves-with-fault-and-signal', async () => {
  const fake = fakePort();
  const runner = new AcceptanceRunner(fake.port);
  const accepting = runner.accept();
  assert.equal(runner.busy, true, '验收在途时 busy 不是 true');
  fake.spawned[0]!.emit(0, null);
  assert.deepEqual(await bounded(accepting, 'first'), { fault: 'exited', signal: null });
  assert.equal(runner.busy, false, '完成后 busy 未释放');
  // 信号必须原样保留在结果里（契约第 5 条）。
  const second = runner.accept();
  fake.spawned[1]!.emit(null, 'SIGTERM');
  const result = await bounded(second, 'second');
  assert.equal(result.fault, 'killed');
  assert.equal(result.signal, 'SIGTERM', '信号没有原样保留');
});

test('hidden/rejects-concurrent-acceptance-without-spawning', async () => {
  // 契约第 3 条：在途时再次 accept 必须抛 BusyError，且**不得启动第二个子进程**。
  const fake = fakePort();
  const runner = new AcceptanceRunner(fake.port);
  const first = runner.accept();
  assert.equal(runner.busy, true);
  // 缺陷版不会拒绝重入：这些 accept 会真的返回未结算的 promise。
  // 用有界等待取出结果，避免断言失败时留下悬挂 promise 让整个文件挂起。
  const reentries: Promise<unknown>[] = [];
  for (let i = 0; i < 3; i += 1) {
    reentries.push(runner.accept().then(() => 'resolved' as const, (error: unknown) =>
      error instanceof BusyError ? 'busy' as const : 'other:' + String(error)));
  }
  const outcomes = await bounded(Promise.all(reentries), 'reentries');
  assert.deepEqual(outcomes, ['busy', 'busy', 'busy'], '重入没有被 BusyError 拒绝');
  assert.equal(fake.spawned.length, 1, '重入启动了额外子进程');
  // 被拒绝的重入不得影响在途验收。
  // 缺陷版会让每次重入都真的启动子进程，必须把**所有**已启动的子进程都放行，
  // 否则未结算的 promise 会让整个文件挂起。
  for (const child of fake.spawned) child.emit(0, null);
  assert.deepEqual(await bounded(first, 'first'), { fault: 'exited', signal: null });
  assert.equal(runner.busy, false);
  // 释放后可以再次验收，且真的会启动新进程。
  const second = runner.accept();
  assert.equal(fake.spawned.length, 2, '释放后没有启动新进程');
  fake.spawned[1]!.emit(1, null);
  assert.deepEqual(await bounded(second, 'second-after-release'), { fault: 'crashed', signal: null });
});

test('hidden/every-outcome-reaps-in-launch-order', async () => {
  // 契约第 2 条：无论哪类结束都必须回收并记入 reaped，pid 顺序与启动顺序一致。
  // 验收必须串行：契约第 3 条禁止并发 accept。
  for (const [label, code, signal] of [['exited', 0, null], ['crashed', 3, null], ['killed', null, 'SIGKILL']] as const) {
    const fake = fakePort();
    const runner = new AcceptanceRunner(fake.port);
    const pids: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      const accepting = runner.accept();
      const last = fake.spawned[fake.spawned.length - 1]!;
      pids.push(last.pid);
      last.emit(code, signal);
      await bounded(accepting, 'accept');
      assert.deepEqual([...runner.reaped], pids, label + ' 第 ' + round + ' 轮：reaped 顺序不对');
    }
    assert.equal(fake.spawned.length, 3, label + '：子进程数不对');
  }
});

test('hidden/kill-is-called-for-faults-and-signals-only', async () => {
  // 契约第 2 条：故障与信号终止还要调用 kill()；正常退出不需要。
  const scenarios: Array<[string, number | null, string | null, boolean]> = [
    ['exited', 0, null, false],
    ['crashed', 9, null, true],
    ['killed', null, 'SIGINT', true],
  ];
  for (const [label, code, signal, expectKill] of scenarios) {
    const fake = fakePort();
    const runner = new AcceptanceRunner(fake.port);
    const accepting = runner.accept();
    fake.spawned[0]!.emit(code, signal);
    await bounded(accepting, 'accept');
    assert.equal(fake.spawned[0]!.killCount, expectKill ? 1 : 0,
      label + '：kill 调用次数是 ' + fake.spawned[0]!.killCount);
    // 无论是否 kill，都必须回收。
    assert.deepEqual([...runner.reaped], [fake.spawned[0]!.pid], label + '：没有回收');
  }
});

test('hidden/reaped-does-not-expose-the-internal-array', async () => {
  const fake = fakePort();
  const runner = new AcceptanceRunner(fake.port);
  const a = runner.accept();
  fake.spawned[0]!.emit(0, null);
  await bounded(a, 'a');
  // 修改取出的数组不得污染内部状态（契约要求 getter 返回 readonly 视图）。
  const first = runner.reaped;
  (first as number[]).push(99999);
  assert.deepEqual([...runner.reaped], [fake.spawned[0]!.pid], 'reaped 暴露了内部数组');
  // 继续回收：内部记录只增不减，且顺序保持。
  const b = runner.accept();
  fake.spawned[1]!.emit(0, null);
  await bounded(b, 'b');
  assert.deepEqual([...runner.reaped], [fake.spawned[0]!.pid, fake.spawned[1]!.pid],
    '内部回收记录被外部修改污染了');
  assert.notEqual(runner.reaped, runner.reaped, '每次读取都返回同一数组引用');
});

test('hidden/three-rounds-of-accept-and-reject', async () => {
  // 多轮「验收 → 重入被拒 → 结束 → 再验收」必须稳定。
  const fake = fakePort();
  const runner = new AcceptanceRunner(fake.port);
  for (let round = 1; round <= 3; round += 1) {
    const accepting = runner.accept();
    assert.equal(runner.busy, true, '第 ' + round + ' 轮 busy 不对');
    // 缺陷版的重入会返回未结算 promise：用有界等待取结果，不断言抛错。
    const reentry = runner.accept().then(() => 'resolved' as const, (error: unknown) =>
      error instanceof BusyError ? 'busy' as const : 'other:' + String(error));
    assert.equal(await bounded(reentry, 'reentry-' + round), 'busy', '第 ' + round + ' 轮重入未被拒');
    // 放行本轮与重入可能启动的所有子进程。
    for (const child of fake.spawned) if (child.pid >= fake.spawned[round - 1]!.pid) child.emit(0, null);
    await bounded(accepting, 'accept-' + round);
    assert.equal(runner.busy, false, '第 ' + round + ' 轮未释放');
    assert.equal(runner.reaped.length, round, '第 ' + round + ' 轮回收数不对');
  }
  // 恰好三次子进程，没有泄漏。
  assert.equal(fake.spawned.length, 3);
});
