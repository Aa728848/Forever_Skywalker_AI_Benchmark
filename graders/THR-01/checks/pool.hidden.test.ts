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
  await assert.rejects(async () => runPool(jobs(2), { size: 0 }), RangeError);
  await assert.rejects(async () => runPool(jobs(2), { size: 1.5 }), RangeError);
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
    const outcome = await runPool(jobs(9), {size: 2});
    assert.equal(created.length, 2, '九项作业必须使用恰好两个真实线程，而非自报 id');
    assert.equal(observed.size, 9, '每项结果须有真实 worker 消息');
    assert.equal(exited.size, created.length, '返回前工作线程必须全部退出');
    assert.deepEqual([...new Set(observed.values())].sort((a,b)=>a-b), [...outcome.threadIds].sort((a,b)=>a-b));
  } finally {
    workerThreads.Worker = Original;
    syncBuiltinESMExports();
    await Promise.all(created.map(worker => worker.terminate()));
  }
});
