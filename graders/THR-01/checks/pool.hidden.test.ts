import test from 'node:test';
import assert from 'node:assert/strict';
import { runPool, type Job } from '../starter/src/pool.ts';

function jobs(count: number): Job[] {
  return Array.from({ length: count }, (_unused, index) => ({ id: 'job-' + index, payload: index + 1 }));
}

test('hidden/computes-each-job', async () => {
  const outcome = await runPool(jobs(6));
  assert.deepEqual(outcome.results, { 'job-0': 2, 'job-1': 4, 'job-2': 6, 'job-3': 8, 'job-4': 10, 'job-5': 12 });
  assert.deepEqual(outcome.failures, []);
});

test('hidden/uses-real-worker-threads', async () => {
  const outcome = await runPool(jobs(4), { size: 2 });
  assert.ok(outcome.threadIds.length >= 2, '必须由至少两个真实 worker 线程处理，实际 ' + JSON.stringify(outcome.threadIds));
  assert.ok(outcome.threadIds.every(id => id !== 0), '主线程 id 0 不得出现在结果里');
});

test('hidden/reports-failed-jobs', async () => {
  const outcome = await runPool([...jobs(3), { id: 'bad', payload: -1 }]);
  assert.deepEqual(outcome.failures, ['bad']);
  assert.equal(Object.keys(outcome.results).length, 3);
});

test('hidden/empty-input-creates-no-threads', async () => {
  const outcome = await runPool([]);
  assert.deepEqual(outcome, { results: {}, failures: [], threadIds: [] });
});

test('hidden/rejects-invalid-size', async () => {
  // 契约第 5 条：size 必须是 ≥1 的整数。
  for (const size of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(async () => runPool(jobs(2), { size }), RangeError, 'size=' + String(size));
  }
  // 1 是合法边界。
  const single = await runPool(jobs(2), { size: 1 });
  assert.equal(Object.keys(single.results).length, 2, 'size=1 时没有处理全部作业');
});

test('hidden/single-job-still-uses-a-worker-thread', async () => {
  // 契约第 1 条：即使只有一个 job，也必须走真实 worker 线程。
  const outcome = await runPool([{ id: 'only', payload: 3 }]);
  assert.deepEqual(outcome.results, { only: 6 });
  assert.deepEqual(outcome.failures, []);
  assert.equal(outcome.threadIds.length, 1, '单个作业没有记录线程');
  assert.notEqual(outcome.threadIds[0], 0, '主线程 id 0 不得出现');
});

test('hidden/size-larger-than-jobs-caps-thread-count', async () => {
  // 契约第 2 条：线程总数不得超过 job 数量。
  const outcome = await runPool(jobs(2), { size: 16 });
  assert.equal(Object.keys(outcome.results).length, 2);
  assert.ok(outcome.threadIds.length <= 2, '线程数超过了作业数：' + JSON.stringify(outcome.threadIds));
  assert.ok(outcome.threadIds.every(id => id !== 0));
});

test('hidden/negative-payloads-do-not-affect-others', async () => {
  // 契约第 3 条：失败 job 既不进 results，也不影响其它 job。
  const mixed: Job[] = [
    { id: 'ok1', payload: 1 },
    { id: 'bad1', payload: -1 },
    { id: 'ok2', payload: 2 },
    { id: 'bad2', payload: -100 },
    { id: 'zero', payload: 0 },
  ];
  const outcome = await runPool(mixed, { size: 2 });
  assert.deepEqual(Object.keys(outcome.results).sort(), ['ok1', 'ok2', 'zero']);
  assert.equal(outcome.results.ok1, 2);
  assert.equal(outcome.results.ok2, 4);
  // payload 为 0 不是失败：worker 只把负数判为失败。
  assert.equal(outcome.results.zero, 0, 'payload=0 被误判为失败');
  assert.equal(outcome.failures.includes('zero'), false);
  assert.deepEqual([...outcome.failures].sort(), ['bad1', 'bad2']);
  for (const id of outcome.failures) {
    assert.equal(Object.hasOwn(outcome.results, id), false, id + ' 同时出现在 results 与 failures');
  }
});

test('hidden/empty-input-rejects-invalid-size-too', async () => {
  // 契约第 4 条说空输入不创建线程；size 校验仍须生效（避免空数组绕过校验）。
  const empty = await runPool([]);
  assert.deepEqual(empty, { results: {}, failures: [], threadIds: [] });
  await assert.rejects(async () => runPool([], { size: 0 }), RangeError);
});

test('hidden/input-array-is-not-mutated', async () => {
  // 契约第 6 条：不得修改传入数组。
  const input: Job[] = [
    { id: 'a', payload: 1 },
    { id: 'b', payload: -1 },
    { id: 'c', payload: 3 },
  ];
  const snapshot = JSON.stringify(input);
  const lengthBefore = input.length;
  const outcome = await runPool(input, { size: 2 });
  assert.equal(JSON.stringify(input), snapshot, '传入的 jobs 数组被修改了');
  assert.equal(input.length, lengthBefore);
  assert.deepEqual(Object.keys(outcome.results).sort(), ['a', 'c']);
  assert.deepEqual([...outcome.failures].sort(), ['b']);
});

test('hidden/repeated-calls-do-not-leak-thread-ids', async () => {
  // 连续多次调用：每次都必须是全新的 worker，主线程 id 不得混入。
  const first = await runPool(jobs(4), { size: 2 });
  const second = await runPool(jobs(4), { size: 2 });
  for (const outcome of [first, second]) {
    assert.equal(Object.keys(outcome.results).length, 4, '第二次调用没有处理全部作业');
    assert.ok(outcome.threadIds.length >= 1);
    assert.equal(outcome.threadIds.includes(0), false, '主线程 id 0 出现在结果里');
  }
});

test('hidden/large-batch-processes-every-job', async () => {
  // 契约没有规定重复 id 的语义，因此只验证大批量下不丢作业。
  const many = await runPool(jobs(24), { size: 4 });
  assert.equal(Object.keys(many.results).length, 24, '大批量作业有丢失');
  assert.deepEqual(many.failures, []);
  assert.ok(many.threadIds.length >= 2, '大批量没有用到多个线程');
  assert.ok(many.threadIds.length <= 4, '线程数超过了 size：' + JSON.stringify(many.threadIds));
  for (let index = 0; index < 24; index += 1) {
    assert.equal(many.results['job-' + index], (index + 1) * 2, 'job-' + index + ' 的结果不对');
  }
});

// 从运行时观测 Worker 构造和消息，不能采信候选自报的 threadIds。
import workerThreads from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';
test('hidden/observes-real-workers-and-exit', async () => {
  const Original = workerThreads.Worker;
  const created: InstanceType<typeof Original>[] = [];
  const observed = new Map<string, number>();
  const exited = new Set<InstanceType<typeof Original>>();
  workerThreads.Worker = class ObservedWorker extends Original {
    constructor(...args: ConstructorParameters<typeof Original>) {
      super(...args);
      created.push(this);
      this.on('message', message => observed.set(message.id, this.threadId));
      this.on('exit', () => exited.add(this));
    }
  };
  syncBuiltinESMExports();
  try {
    const outcome = await runPool(jobs(9), { size: 2 });
    // 契约第 2 条：线程总数**不得超过** size，且不得超过作业数——不要求恰好用满。
    assert.ok(created.length >= 1, '没有创建任何真实线程');
    assert.ok(created.length <= 2, '创建的线程数超过了 size：' + created.length);
    assert.ok(created.length <= 9, '创建的线程数超过了作业数：' + created.length);
    // 每项结果都必须来自真实 worker 消息，不能是候选自报。
    assert.equal(observed.size, 9, '每项结果须有真实 worker 消息');
    assert.equal(exited.size, created.length, '返回前工作线程必须全部退出');
    // 自报的 threadIds 必须与运行时观测到的一致。
    assert.deepEqual([...new Set(observed.values())].sort((a, b) => a - b), [...outcome.threadIds].sort((a, b) => a - b));
    assert.equal(outcome.threadIds.includes(0), false, '自报的 threadIds 混入了主线程 0');
  } finally {
    workerThreads.Worker = Original;
    syncBuiltinESMExports();
    await Promise.all(created.map(worker => worker.terminate()));
  }
});
