import test from 'node:test';
import assert from 'node:assert/strict';
import { SubmitError, TaskSubmitter, type TaskStore } from '../starter/src/submit.ts';

function memoryStore(initial: Record<string, string> = {}) {
  const entries = new Map<string, string>(Object.entries(initial));
  const writes: string[] = [];
  let failNextWrite = false;
  const store: TaskStore = {
    read(key) { return entries.get(key) ?? null; },
    write(key, value) {
      if (failNextWrite) { failNextWrite = false; throw new Error('磁盘满'); }
      writes.push(key + '=' + value);
      entries.set(key, value);
    },
  };
  return {
    store,
    entries,
    writes,
    failNextWrite() { failNextWrite = true; },
  };
}

test('hidden/submits-and-records-task-id', async () => {
  const memory = memoryStore();
  const submitter = new TaskSubmitter(memory.store);
  const taskId = await submitter.submit('order-1', 'payload');
  assert.equal(typeof taskId, 'string');
  assert.deepEqual(submitter.committed, [taskId]);
  assert.equal(memory.writes.length, 1);
});

test('hidden/repeated-key-returns-same-task-id', async () => {
  const memory = memoryStore();
  const submitter = new TaskSubmitter(memory.store);
  const first = await submitter.submit('order-2', 'a');
  const second = await submitter.submit('order-2', 'b');
  assert.equal(second, first, '同一提交键必须返回同一个 taskId');
  assert.equal(memory.writes.length, 1, '幂等提交不得再写第二条');
  assert.deepEqual(submitter.committed, [first]);
});

test('hidden/restart-reuses-existing-record', async () => {
  const memory = memoryStore();
  const first = await new TaskSubmitter(memory.store).submit('order-3', 'x');
  // 模拟进程重启：新的 submitter 读同一份存储。
  const restarted = new TaskSubmitter(memory.store);
  assert.equal(await restarted.submit('order-3', 'y'), first);
  assert.equal(memory.writes.length, 1);
  assert.equal(memory.entries.size, 1);
});

test('hidden/failed-write-leaves-no-partial-record', async () => {
  const memory = memoryStore();
  const submitter = new TaskSubmitter(memory.store);
  memory.failNextWrite();
  await assert.rejects(async () => submitter.submit('order-4', 'z'), SubmitError);
  assert.deepEqual(submitter.committed, []);
  assert.equal(memory.entries.size, 0);
  const retried = await submitter.submit('order-4', 'z');
  assert.deepEqual(submitter.committed, [retried]);
});

test('hidden/distinct-keys-get-distinct-ids-and-empty-key-is-rejected', async () => {
  const memory = memoryStore();
  const submitter = new TaskSubmitter(memory.store);
  const first = await submitter.submit('k1', 'a');
  const second = await submitter.submit('k2', 'b');
  assert.notEqual(first, second);
  await assert.rejects(async () => submitter.submit('', 'c'), SubmitError);
  assert.equal(memory.entries.size, 2);
});

test('hidden/restart-new-key-has-unique-id', async () => {
  const memory = memoryStore();
  const first = await new TaskSubmitter(memory.store).submit('before-restart', 'a');
  const restarted = new TaskSubmitter(memory.store);
  const second = await restarted.submit('after-restart', 'b');
  assert.notEqual(first, second, '不同键跨进程实例仍必须得到不同 taskId');
  assert.equal(await restarted.submit('before-restart', 'a'), first);
  assert.equal(memory.entries.size, 2);
});

test('hidden/resource-retries-do-not-accumulate', async () => {
  const memory = memoryStore();
  const submitter = new TaskSubmitter(memory.store);
  const id = await submitter.submit('retried', 'payload');
  for (let index = 0; index < 2000; index += 1) await submitter.submit('retried', 'payload');
  assert.equal(memory.writes.length, 1, '重复提交不得累积写入或提交记录');
  assert.deepEqual(submitter.committed, [id]);
  assert.equal(memory.entries.size, 1);
});
