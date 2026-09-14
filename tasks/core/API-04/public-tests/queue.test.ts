import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DurableQueue, QueueError } from '../starter/src/queue.ts';
import { runOne } from '../starter/src/worker.ts';

function withQueue(body: (queue: DurableQueue) => void | Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'api04-public-'));
  const queue = new DurableQueue(join(directory, 'queue.db'));
  return Promise.resolve().then(() => body(queue)).finally(() => {
    queue.close();
    rmSync(directory, { recursive: true, force: true });
  });
}

test('public/durable-submit-flow', () => withQueue(async queue => {
  const id = queue.submit('report', '输入|中文\n');
  assert.equal(await runOne(queue, 'worker-a', () => 10, 30, async payload => payload.toUpperCase()), 'completed');
  assert.equal(await runOne(queue, 'worker-b', () => 10, 30, async () => 'unused'), 'idle');
  assert.equal(queue.snapshot().tasks[0]?.state, 'completed');
  assert.deepEqual(queue.snapshot().results.map(row => ({ ...row })), [{ taskId: id, value: '输入|中文\n' }]);
}));

test('public/durable-content-conflict', () => withQueue(queue => {
  const id = queue.submit('same-request', '{"amount":5}');
  assert.equal(queue.submit('same-request', '{"amount":5}'), id);
  assert.throws(() => queue.submit('same-request', '{"amount":6}'), error => error instanceof QueueError && error.code === 'conflict');
  assert.equal(queue.snapshot().tasks.length, 1);
  assert.equal(queue.snapshot().revision, 1);
}));

test('public/durable-expired-lease-fencing', () => withQueue(queue => {
  queue.submit('job', 'payload');
  const first = queue.claim('worker', 0, 10)!;
  assert.equal(queue.claim('other', 9, 10), null);
  const second = queue.claim('worker', 10, 10)!;
  assert.ok(second.generation > first.generation, '新的领取不能复用旧代际');
  assert.equal(queue.complete(first, 'late result', 11), false);
  assert.equal(queue.complete(second, 'current result', 11), true);
  assert.equal(queue.complete(second, 'current result', 999), true, '完成确认重试不产生第二次结果');
}));

test('public/durable-result-failure-is-atomic', () => {
  const directory = mkdtempSync(join(tmpdir(), 'api04-failure-'));
  let fail = true;
  const queue = new DurableQueue(join(directory, 'queue.db'), {
    onCheckpoint(phase) { if (phase === 'result-written' && fail) throw new Error('injected write failure'); },
  });
  try {
    queue.submit('job', 'payload');
    const lease = queue.claim('worker', 0, 10)!;
    assert.throws(() => queue.complete(lease, 'result', 1), /injected write failure/);
    assert.equal(queue.snapshot().results.length, 0);
    assert.equal(queue.snapshot().tasks[0]?.state, 'leased');
    assert.equal(queue.snapshot().revision, 2);
    fail = false;
    assert.equal(queue.complete(lease, 'result', 2), true);
  } finally {
    queue.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
