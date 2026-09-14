import test from 'node:test';
import assert from 'node:assert/strict';
import { CheckpointStore, LedgerError, type Journal } from '../starter/src/ledger.ts';

function memoryJournal(initial: readonly string[] = []) {
  const entries: string[] = [...initial];
  const journal: Journal = {
    append(entry) { entries.push(entry); },
    read() { return [...entries]; },
  };
  return { journal, entries };
}

test('public/applies-entries-and-tracks-checkpoint', () => {
  const { journal } = memoryJournal();
  const store = new CheckpointStore(journal);
  assert.equal(store.balance, 0);
  assert.equal(store.apply([10, 20]), 30);
  assert.equal(store.checkpoint, 2);
  assert.equal(store.balance, 30);
});

test('public/recover-does-not-double-count', () => {
  const { journal } = memoryJournal();
  const store = new CheckpointStore(journal);
  store.apply([10, 20]);
  assert.equal(store.recover(), 30, '重复 recover 不得重复入账');
  assert.equal(store.recover(), 30);
  assert.equal(store.checkpoint, 2);
});

test('public/crash-recovery-replays-journal-once', () => {
  const { journal } = memoryJournal();
  const store = new CheckpointStore(journal);
  store.apply([5, 15]);
  // 模拟进程重启：新实例从同一本日志恢复，只应再入账一次。
  const recovered = new CheckpointStore(journal);
  assert.equal(recovered.balance, 20);
  assert.equal(recovered.checkpoint, 2);
  recovered.apply([1]);
  assert.equal(recovered.balance, 21);
  assert.equal(recovered.recover(), 21);
});

test('public/replays-entries-appended-by-others', () => {
  const { journal } = memoryJournal();
  const store = new CheckpointStore(journal);
  store.apply([3]);
  journal.append('7');
  assert.equal(store.recover(), 10);
  assert.equal(store.recover(), 10);
  assert.equal(store.checkpoint, 2);
});

test('public/rejects-invalid-journal-entries', () => {
  const { journal } = memoryJournal(['not-a-number']);
  assert.throws(() => new CheckpointStore(journal), LedgerError);
});
