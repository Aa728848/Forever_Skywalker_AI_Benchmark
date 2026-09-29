import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DurableQueue, QueueError, type QueueSnapshot } from '../starter/src/queue.ts';
import { runOne } from '../starter/src/worker.ts';

function withQueue<T>(run: (queue: DurableQueue) => T, options?: { onCheckpoint?: (phase: string) => void; busyTimeoutMs?: number }): T {
  const directory = mkdtempSync(join(tmpdir(), 'api04-contract-'));
  const queue = new DurableQueue(join(directory, 'queue.db'), options);
  try {
    return run(queue);
  } finally {
    try { queue.close(); } catch { /* 已关闭 */ }
    cleanup(directory);
  }
}

/**
 * Windows 上 SQLite 句柄释放可能滞后于 close()，导致 rmSync 抛 EPERM。
 * 测试要验证的是账本行为而不是文件系统时序，因此清理失败只重试并最终忽略。
 */
function cleanup(directory: string): void {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { rmSync(directory, { recursive: true, force: true }); return; }
    catch { /* 句柄尚未释放，稍后重试 */ }
  }
}
const code = (expected: QueueError['code']) => (error: unknown) =>
  error instanceof QueueError && error.code === expected;

test('hidden/new-key-identity-is-permanent-and-fifo-ordered', () => {
  // 契约第 1 条：新 key 得到永久唯一 ID，初始 queued/代际 0/owner 与 leaseUntil 为 null；
  // 按首次提交成功顺序排队。
  withQueue(queue => {
    const first = queue.submit('a', 'pa');
    const second = queue.submit('b', 'pb');
    const third = queue.submit('c', 'pc');
    assert.equal(new Set([first, second, third]).size, 3, '不同 key 得到了相同 ID');
    const snapshot = queue.snapshot();
    assert.deepEqual(snapshot.tasks.map(task => task.key), ['a', 'b', 'c'], '排队顺序不对');
    for (const task of snapshot.tasks) {
      assert.equal(task.state, 'queued', task.key + ' 初始状态不是 queued');
      assert.equal(task.generation, 0, task.key + ' 初始代际不是 0');
      assert.equal(task.owner, null, task.key + ' 初始 owner 不是 null');
      assert.equal(task.leaseUntil, null, task.key + ' 初始 leaseUntil 不是 null');
      assert.equal(task.payload, task.key === 'a' ? 'pa' : task.key === 'b' ? 'pb' : 'pc');
    }
    // 同键同内容重试返回原 ID。
    assert.equal(queue.submit('a', 'pa'), first, '同键同内容没有返回原 ID');
    assert.equal(queue.snapshot().tasks.length, 3, '重试创建了新任务');
  });
});

test('hidden/conflict-and-boundary-inputs-leave-state-untouched', () => {
  // 契约第 2、14 条：内容冲突抛 conflict；空键/空 worker/非法时刻/非正 leaseMs 抛 invalid。
  withQueue(queue => {
    const id = queue.submit('key', 'original');
    const before = JSON.stringify(queue.snapshot());
    // 同键不同内容。
    assert.throws(() => queue.submit('key', 'different'), code('conflict'));
    assert.equal(JSON.stringify(queue.snapshot()), before, '冲突后状态变了');
    // 空内容是合法的。
    assert.equal(queue.submit('empty-payload', ''), queue.snapshot().tasks[1]!.id);
    // 键是数据：Unicode、换行、竖线与路径形字符串都合法。
    for (const key of ['键', 'a\nb', 'a|b', '../escape', './x', 'C:\\path']) {
      const created = queue.submit(key, 'v');
      assert.equal(typeof created, 'string', '键 ' + JSON.stringify(key) + ' 被拒绝');
    }
    // 空键抛 invalid 且不改变状态。
    const stable = JSON.stringify(queue.snapshot());
    assert.throws(() => queue.submit('', 'x'), code('invalid'));
    assert.equal(JSON.stringify(queue.snapshot()), stable, '空键后状态变了');
    // claim 的非法参数。
    assert.throws(() => queue.claim('', 0, 100), code('invalid'));
    assert.throws(() => queue.claim('w', -1, 100), code('invalid'));
    assert.throws(() => queue.claim('w', 1.5, 100), code('invalid'));
    assert.throws(() => queue.claim('w', 0, 0), code('invalid'));
    assert.throws(() => queue.claim('w', 0, -1), code('invalid'));
    assert.throws(() => queue.claim('w', 0, 1.5), code('invalid'));
    assert.throws(() => queue.claim('w', Number.NaN, 10), code('invalid'));
    assert.throws(() => queue.claim('w', 0, Number.POSITIVE_INFINITY), code('invalid'));
    // 相加溢出。
    assert.throws(() => queue.claim('w', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), code('invalid'));
    assert.equal(JSON.stringify(queue.snapshot()), stable, '非法参数后状态变了');
    assert.equal(id, queue.snapshot().tasks[0]!.id);
  });
});

test('hidden/lease-generation-fencing-rejects-stale-completions', () => {
  // 契约第 6、7、9 条：领取加代际；complete 只接受全部字段相符且未过期的租约；
  // 租约重领使旧执行失去提交权限（即使 worker 名称相同）。
  withQueue(queue => {
    const taskId = queue.submit('fenced', 'payload');
    const first = queue.claim('worker-same', 100, 50)!;
    assert.equal(first.taskId, taskId);
    assert.equal(first.generation, 1, '首次领取代际不是 1');
    assert.equal(first.expiresAt, 150, 'expiresAt 计算不对');
    // 未过期时可以用原租约完成。
    const leaseCopy = { ...first };
    assert.equal(queue.complete(leaseCopy, 'result', 149), true, '有效租约未能完成');
    // 已完成任务不可再领取。
    assert.equal(queue.claim('worker-same', 200, 50), null, '已完成任务被再次领取');

    // 第二个任务：租约过期后被重领，旧代际必须失效。
    queue.submit('regrant', 'payload');
    const stale = queue.claim('worker-same', 100, 50)!;
    const fresh = queue.claim('worker-same', 150, 50)!;
    assert.notEqual(fresh.generation, stale.generation, '重领没有推进代际');
    // 旧代际即使 worker 名称相同也必须被拒。
    assert.equal(queue.complete(stale, 'stale result', 151), false, '旧代际完成了任务');
    assert.equal(queue.snapshot().tasks.find(task => task.id === fresh.taskId)!.state, 'leased',
      '被旧代际改成了已完成');
    // 新代际可以完成。
    assert.equal(queue.complete(fresh, 'fresh result', 152), true);
    // 伪造字段一律拒绝。
    queue.submit('forged', 'p');
    const real = queue.claim('w1', 100, 100)!;
    for (const forged of [
      { ...real, taskId: 'nonexistent' },
      { ...real, worker: 'someone-else' },
      { ...real, generation: real.generation + 1 },
      { ...real, expiresAt: real.expiresAt + 1 },
    ]) {
      assert.equal(queue.complete(forged, 'x', 101), false, '伪造租约被接受了');
    }
    // 过期租约（now >= leaseUntil）被拒。
    assert.equal(queue.complete(real, 'x', real.expiresAt), false, '过期租约被接受');
    assert.equal(queue.complete(real, 'x', real.expiresAt - 1), true, '未过期租约被拒');
  });
});

test('hidden/idempotent-completion-and-result-conflict', () => {
  // 契约第 8 条：相同完成令牌与相同结果重试返回 true（即使晚于期限）且不增加 revision；
  // 结果不同抛 conflict；已完成任务的其他代际返回 false。
  withQueue(queue => {
    const taskId = queue.submit('idem', 'p');
    const lease = queue.claim('w', 100, 50)!;
    const revisionBefore = queue.snapshot().revision;
    assert.equal(queue.complete(lease, 'value', 120), true);
    const revisionAfter = queue.snapshot().revision;
    assert.ok(revisionAfter > revisionBefore, '首次完成没有推进 revision');
    // 相同令牌 + 相同结果 + 晚于期限：仍返回 true，revision 不变。
    assert.equal(queue.complete(lease, 'value', 999), true, '幂等重放返回了 false');
    assert.equal(queue.snapshot().revision, revisionAfter, '幂等重放增加了 revision');
    // 结果不同：抛 conflict。
    assert.throws(() => queue.complete(lease, 'different', 1000), code('conflict'));
    assert.equal(queue.snapshot().results[0]!.value, 'value', '冲突后结果被改写');
    // 已完成任务的其他代际：返回 false。
    const otherLease = { ...lease, generation: lease.generation + 1 };
    assert.equal(queue.complete(otherLease, 'value', 1001), false, '其他代际被接受了');
    assert.equal(queue.complete({ ...lease, worker: 'other' }, 'value', 1002), false, '其他 worker 被接受了');
    // 结果历史不增长。
    assert.equal(queue.snapshot().results.length, 1, '结果历史增长了');
  });
});

test('hidden/revision-counts-only-real-changes', () => {
  // 契约第 12 条：每次新提交、领取、首次完成各 +1；拒绝、失败、空领取与幂等重放不增。
  withQueue(queue => {
    assert.equal(queue.snapshot().revision, 0, '初始 revision 不是 0');
    const id = queue.submit('k', 'v');
    assert.equal(queue.snapshot().revision, 1, '提交后 revision 不是 1');
    // 幂等重放。
    assert.equal(queue.submit('k', 'v'), id);
    assert.equal(queue.snapshot().revision, 1, '幂等提交增加了 revision');
    // 冲突拒绝。
    assert.throws(() => queue.submit('k', 'other'), code('conflict'));
    assert.equal(queue.snapshot().revision, 1, '冲突增加了 revision');
    // 成功领取：此时队列里有刚提交的 'k'。
    const lease = queue.claim('w', 0, 10)!;
    assert.equal(queue.snapshot().revision, 2, '领取后 revision 不是 2');
    // 已被别人领取：再次领取不增。
    const second = queue.claim('w2', 0, 10);
    assert.equal(second, null, '同一任务被并发领取');
    assert.equal(queue.snapshot().revision, 2, '失败的领取增加了 revision');
    // 首次完成。
    assert.equal(queue.complete(lease, 'r', 1), true);
    assert.equal(queue.snapshot().revision, 3, '完成后 revision 不是 3');
    // 幂等重放完成。
    assert.equal(queue.complete(lease, 'r', 2), true);
    assert.equal(queue.snapshot().revision, 3, '幂等完成增加了 revision');
  });
});

test('hidden/snapshot-is-independent-copy-with-stable-order', () => {
  // 契约第 12 条：snapshot 返回独立副本；任务按首次提交顺序，结果按首次完成顺序。
  withQueue(queue => {
    queue.submit('t1', 'p1');
    queue.submit('t2', 'p2');
    queue.submit('t3', 'p3');
    const l1 = queue.claim('w', 0, 10)!;
    queue.complete(l1, 'result-1', 1);
    const l2 = queue.claim('w', 0, 10)!;
    queue.complete(l2, 'result-2', 1);
    const snapshot = queue.snapshot();
    // 任务按首次提交顺序。
    assert.deepEqual(snapshot.tasks.map(task => task.key), ['t1', 't2', 't3']);
    // 结果按首次完成顺序。
    assert.deepEqual(snapshot.results.map(result => result.value), ['result-1', 'result-2']);
    // 独立副本：修改取出值不得影响内部状态。
    (snapshot.tasks as Array<{ key: string }>).push({ key: 'injected' } as never);
    (snapshot.results as Array<{ value: string }>).push({ value: 'injected' } as never);
    (snapshot.tasks[0] as { state: string }).state = 'injected';
    const again = queue.snapshot();
    assert.deepEqual(again.tasks.map(task => task.key), ['t1', 't2', 't3'], 'snapshot 暴露了内部状态');
    assert.equal(again.tasks[0]!.state, 'completed', 'snapshot 的任务状态被外部改写');
    assert.deepEqual(again.results.map(result => result.value), ['result-1', 'result-2'], 'snapshot 的结果被外部改写');
    // 两次读取返回不同对象。
    assert.notEqual(queue.snapshot(), queue.snapshot(), '两次 snapshot 返回了同一对象');
  });
});

test('hidden/close-is-idempotent-and-locks-every-method', () => {
  // 契约第 13 条：close 释放资源；重复 close 无害；关闭后其它方法抛 closed。
  const directory = mkdtempSync(join(tmpdir(), 'api04-close-'));
  const queue = new DurableQueue(join(directory, 'queue.db'));
  try {
    const id = queue.submit('k', 'v');
    const lease = queue.claim('w', 0, 10)!;
    queue.close();
    queue.close();
    queue.close();
    for (const call of [
      () => queue.submit('after', 'x'),
      () => queue.claim('w', 0, 10),
      () => queue.complete(lease, 'r', 1),
    ]) {
      assert.throws(call, code('closed'), '关闭后方法没有抛 closed');
    }
    assert.throws(() => queue.snapshot(), code('closed'), '关闭后 snapshot 没有抛 closed');
    // 关闭前的数据仍可通过新实例读回。
    const reopened = new DurableQueue(join(directory, 'queue.db'));
    try {
      assert.equal(reopened.snapshot().tasks[0]!.id, id, '重开后任务不见了');
      assert.equal(reopened.snapshot().tasks[0]!.state, 'leased', '重开后状态不对');
    } finally {
      reopened.close();
    }
  } finally {
    cleanup(directory);
  }
});

test('hidden/run-one-covers-idle-completed-and-superseded', async () => {
  // 契约第 10 条：无任务返回 idle；完成返回 completed；失去租约返回 superseded；
  // 执行抛错原样传播且任务保留领取状态。
  // runOne 是异步的：不能用同步的 withQueue 包裹，它会在 await 期间关闭队列。
  const directory = mkdtempSync(join(tmpdir(), 'api04-runone-'));
  const queue = new DurableQueue(join(directory, 'queue.db'));
  try {
    assert.equal(await runOne(queue, 'w', () => 0, 10, async () => 'x'), 'idle', '空队列不是 idle');
    queue.submit('task', 'payload');
    let clock = 0;
    const outcome = await runOne(queue, 'w', () => clock, 50, async (payload, lease) => {
      assert.equal(payload, 'payload', 'runOne 没有传入原始 payload');
      assert.equal(lease.taskId, queue.snapshot().tasks[0]!.id, 'runOne 没有传入本次租约');
      return 'done';
    });
    assert.equal(outcome, 'completed', '正常执行不是 completed');
    assert.equal(queue.snapshot().tasks[0]!.state, 'completed');
    assert.equal(queue.snapshot().results[0]!.value, 'done');
    // 失去租约：执行期间时钟前进，另一个 worker 重领。
    queue.submit('race', 'payload');
    clock = 0;
    const raced = await runOne(queue, 'slow', () => clock, 10, async () => {
      clock = 20;
      const stolen = queue.claim('thief', 20, 10);
      assert.notEqual(stolen, null, '另一个 worker 没有重领到');
      return 'too late';
    });
    assert.equal(raced, 'superseded', '失去租约的执行没有报告 superseded');
    assert.equal(queue.snapshot().tasks.find(task => task.key === 'race')!.state, 'leased',
      '失去租约后任务状态不对');
    // 执行抛错：原样传播，任务保留领取状态等待到期接管。
    queue.submit('boom', 'payload');
    const failure = new Error('执行失败');
    await assert.rejects(
      runOne(queue, 'w', () => 0, 50, async () => { throw failure; }),
      (error: unknown) => error === failure,
      '执行抛错没有原样传播',
    );
    const retained = queue.snapshot().tasks.find(task => task.key === 'boom')!;
    assert.equal(retained.state, 'leased', '执行失败后任务没有保留领取状态');
    assert.equal(retained.generation, 1, '执行失败后代际不对');
  } finally {
    try { queue.close(); } catch { /* 已关闭 */ }
    cleanup(directory);
  }
});

test('hidden/queue-reuse-does-not-accumulate-state', () => {
  // 契约第 13 条：重复重放不持续增大文件、任务或结果历史。
  const directory = mkdtempSync(join(tmpdir(), 'api04-reuse-'));
  const path = join(directory, 'queue.db');
  try {
    const queue = new DurableQueue(path);
    const id = queue.submit('stable', 'payload');
    const lease = queue.claim('w', 0, 1000)!;
    queue.complete(lease, 'result', 1);
    const snapshot = queue.snapshot();
    const taskCount = snapshot.tasks.length;
    const resultCount = snapshot.results.length;
    // 大量幂等重放：任务数、结果数与 revision 都不应增长。
    for (let index = 0; index < 500; index += 1) {
      assert.equal(queue.submit('stable', 'payload'), id);
      assert.equal(queue.complete(lease, 'result', 2), true);
    }
    const after = queue.snapshot();
    assert.equal(after.tasks.length, taskCount, '任务历史增长了');
    assert.equal(after.results.length, resultCount, '结果历史增长了');
    assert.equal(after.revision, snapshot.revision, '幂等重放增加了 revision');
    queue.close();
    // 反复开关也不得累积。
    for (let round = 0; round < 5; round += 1) {
      const reopened = new DurableQueue(path);
      try {
        assert.equal(reopened.snapshot().tasks.length, 1, '重开后任务数变了');
        assert.equal(reopened.snapshot().results.length, 1, '重开后结果数变了');
      } finally {
        reopened.close();
      }
    }
  } finally {
    cleanup(directory);
  }
});
