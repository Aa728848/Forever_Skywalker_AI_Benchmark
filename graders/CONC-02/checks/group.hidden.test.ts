import test from 'node:test';
import assert from 'node:assert/strict';
import { GroupCancelledError, TaskGroup } from '../starter/src/group.ts';

const turn = () => new Promise(resolve => setImmediate(resolve));
const pending = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

test('hidden/active-lists-unsettled-members-in-start-order', async () => {
  // 契约第 1 条：active 只含未结算成员 id，按启动顺序；结算后立刻消失。
  const group = new TaskGroup();
  assert.deepEqual([...group.active], [], '初始 active 不为空');
  const gates = [pending<number>(), pending<number>(), pending<number>()];
  const runs = ['a', 'b', 'c'].map((id, index) => group.run(id, () => gates[index]!.promise));
  assert.deepEqual([...group.active], ['a', 'b', 'c'], 'active 顺序或内容不对');
  // 中间一个先结算：只移除它，其余顺序不变。
  gates[1]!.resolve(1);
  await runs[1];
  assert.deepEqual([...group.active], ['a', 'c'], '结算后 active 不对');
  // 首尾各结算一个。
  gates[0]!.resolve(0);
  await runs[0];
  assert.deepEqual([...group.active], ['c']);
  gates[2]!.resolve(2);
  await runs[2];
  assert.deepEqual([...group.active], [], '全部结算后 active 不为空');
  assert.deepEqual(await Promise.all(runs), [0, 1, 2], '结果原样兑现失败');
});

test('hidden/cancel-all-aborts-signals-and-rejects-with-pending-list', async () => {
  // 契约第 3 条：abort 每个未完成成员，用 GroupCancelledError 拒绝且 pending 列出被取消者。
  const group = new TaskGroup();
  const signals: AbortSignal[] = [];
  const runs = ['x', 'y', 'z'].map(id =>
    group.run(id, signal => { signals.push(signal); return pending<string>().promise; }));
  const outcomes: unknown[] = [];
  runs.forEach((run, index) => { void run.then(value => { outcomes[index] = 'ok:' + value; }, error => { outcomes[index] = error; }); });
  await turn();
  assert.equal(signals.length, 3);
  assert.equal(signals.every(signal => !signal.aborted), true, '取消前 signal 已 abort');

  const cancelling = group.cancelAll();
  await turn();
  // 三个 signal 全部 abort。
  assert.equal(signals.every(signal => signal.aborted), true, 'cancelAll 没有 abort 全部 signal');
  // 全部以 GroupCancelledError 拒绝。
  for (const outcome of outcomes) {
    assert.ok(outcome instanceof GroupCancelledError, '成员不是以 GroupCancelledError 拒绝：' + String(outcome));
  }
  // pending 列出本次被取消的成员 id。
  const pendingIds = [...(outcomes[0] as GroupCancelledError).pending].sort();
  assert.deepEqual(pendingIds, ['x', 'y', 'z'], 'pending 列表不对：' + JSON.stringify(pendingIds));
  // active 已清空。
  assert.deepEqual([...group.active], [], 'cancelAll 后 active 不为空');
  // 契约第 3 条第 4 点：cancelAll 必须等成员真正结算后才兑现。
  // 本测试的成员故意永不结算，因此只验证「尚未兑现」，不 await。
  let settledEarly = false;
  void cancelling.then(() => { settledEarly = true; });
  await turn();
  await turn();
  assert.equal(settledEarly, false, '成员未结算时 cancelAll 就兑现了');
});

test('hidden/cancel-all-resolves-only-after-every-member-settles', async () => {
  // 契约第 3 条第 4 点：必须在所有成员真正结算之后才兑现。
  const group = new TaskGroup();
  const gates = [pending<number>(), pending<number>()];
  const runs = ['a', 'b'].map((id, index) => group.run(id, () => gates[index]!.promise));
  runs.forEach(run => { void run.catch(() => undefined); });
  await turn();
  let cancelled = false;
  const cancelling = group.cancelAll().then(() => { cancelled = true; });
  await turn();
  // 成员尚未结算：cancelAll 不得兑现。
  assert.equal(cancelled, false, '成员未结算时 cancelAll 就兑现了');
  // 结算第一个：仍不得兑现。
  gates[0]!.reject(new Error('late'));
  await turn();
  await turn();
  assert.equal(cancelled, false, '只结算一个成员时 cancelAll 就兑现了');
  // 全部结算后才兑现。
  gates[1]!.reject(new Error('late too'));
  await cancelling;
  assert.equal(cancelled, true, '全部结算后 cancelAll 未兑现');
  await Promise.allSettled(runs);
});

test('hidden/cancel-all-is-noop-when-nothing-is-active', async () => {
  // 契约第 4 条：没有未完成成员时是空操作——不 abort，立即兑现。
  const group = new TaskGroup();
  let cancelled = false;
  const first = group.cancelAll().then(() => { cancelled = true; });
  await first;
  assert.equal(cancelled, true);
  // 全部结算后再调用同样是空操作。
  const done = await group.run('only', async () => 7);
  assert.equal(done, 7);
  assert.deepEqual([...group.active], []);
  let secondCancelled = false;
  await group.cancelAll().then(() => { secondCancelled = true; });
  assert.equal(secondCancelled, true, '空状态下 cancelAll 没有兑现');
  // 空操作不得影响后续成员。
  const after = await group.run('after', async () => 8);
  assert.equal(after, 8);
});

test('hidden/member-failure-is-isolated-and-active-drops-failed-member', async () => {
  // 契约第 2 条：成员自身抛错只影响它自己；失败后 active 里必须消失。
  const group = new TaskGroup();
  const boom = new Error('成员失败');
  const failing = group.run('bad', async () => { throw boom; });
  const healthy = group.run('good', async () => 'ok');
  await assert.rejects(failing, (error: unknown) => error === boom, '没有以原错误拒绝');
  assert.equal(await healthy, 'ok', '其它成员受影响了');
  assert.deepEqual([...group.active], [], '失败的成员仍在 active 里');
  // 同步抛错同样只影响自己。
  const group2 = new TaskGroup();
  const syncThrow = group2.run('sync', () => { throw boom; });
  const survivor = group2.run('alive', async () => 'survived');
  await assert.rejects(syncThrow, (error: unknown) => error === boom);
  assert.equal(await survivor, 'survived');
  assert.deepEqual([...group2.active], []);
});

test('hidden/new-members-after-cancel-all-are-unaffected', async () => {
  // 0.2.0 末段：cancelAll 只取消调用瞬间的成员。
  const group = new TaskGroup();
  // 成员监听 abort 后自行结算，这样 cancelAll 才能真正兑现。
  const oldGate = pending<string>();
  const first = group.run('old', signal => {
    signal.addEventListener('abort', () => { oldGate.reject(new Error('aborted')); }, { once: true });
    return oldGate.promise;
  });
  void first.catch(() => undefined);
  await turn();
  await group.cancelAll();
  // 取消完成后新登记的成员不受影响。
  const fresh = await group.run('new', async () => 'fresh');
  assert.equal(fresh, 'fresh', '新成员被旧取消波及');
  assert.deepEqual([...group.active], []);
  // 新成员还能被下一次 cancelAll 取消。
  const newGate = pending<string>();
  const second = group.run('newer', signal => {
    signal.addEventListener('abort', () => { newGate.reject(new Error('aborted')); }, { once: true });
    return newGate.promise;
  });
  void second.catch(() => undefined);
  await turn();
  assert.deepEqual([...group.active], ['newer']);
  await group.cancelAll();
  assert.deepEqual([...group.active], []);
});

test('hidden/duplicate-active-id-is-rejected-without-corrupting-members', async () => {
  // 0.2.0 末段：活动 id 重复以含 duplicate 的拒绝报告；旧成员结束不得误删新成员。
  const group = new TaskGroup();
  const gate = pending<string>();
  const first = group.run('same', () => gate.promise);
  let duplicate: Promise<unknown> | undefined;
  assert.doesNotThrow(() => { duplicate = group.run('same', async () => 'second'); });
  await assert.rejects(duplicate!, (error: unknown) => {
    assert.ok(error instanceof Error, '重复 id 没有以错误拒绝');
    assert.equal(String(error.message).toLowerCase().includes('duplicate'), true,
      '重复 id 错误信息里没有 duplicate：' + error.message);
    return true;
  }, '重复 id 的拒绝不对');
  // 原成员仍然存活且可正常结算。
  assert.deepEqual([...group.active], ['same'], '重复 id 破坏了 active');
  gate.resolve('first');
  assert.equal(await first, 'first', '原成员受影响');
  assert.deepEqual([...group.active], []);
  // 结算后可以复用该 id。
  const reused = await group.run('same', async () => 'reused');
  assert.equal(reused, 'reused');
});
