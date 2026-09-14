import test from 'node:test';
import assert from 'node:assert/strict';
import { runPool, type Job } from '../starter/src/pool.ts';

function jobs(count: number): Job[] {
  return Array.from({ length: count }, (_unused, index) => ({ id: 'job-' + index, payload: index + 1 }));
}

test('public/computes-each-job', async () => {
  const outcome = await runPool(jobs(6));
  assert.deepEqual(outcome.results, { 'job-0': 2, 'job-1': 4, 'job-2': 6, 'job-3': 8, 'job-4': 10, 'job-5': 12 });
  assert.deepEqual(outcome.failures, []);
});

test('public/uses-real-worker-threads', async () => {
  const outcome = await runPool(jobs(4), { size: 2 });
  assert.ok(outcome.threadIds.length >= 2, '必须由至少两个真实 worker 线程处理，实际 ' + JSON.stringify(outcome.threadIds));
  assert.ok(outcome.threadIds.every(id => id !== 0), '主线程 id 0 不得出现在结果里');
});

test('public/reports-failed-jobs', async () => {
  const outcome = await runPool([...jobs(3), { id: 'bad', payload: -1 }]);
  assert.deepEqual(outcome.failures, ['bad']);
  assert.equal(Object.keys(outcome.results).length, 3);
});

test('public/empty-input-creates-no-threads', async () => {
  const outcome = await runPool([]);
  assert.deepEqual(outcome, { results: {}, failures: [], threadIds: [] });
});

test('public/rejects-invalid-size', async () => {
  await assert.rejects(async () => runPool(jobs(2), { size: 0 }), RangeError);
});
