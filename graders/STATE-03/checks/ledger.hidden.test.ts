import test from 'node:test';
import assert from 'node:assert/strict';
import { CheckpointStore, LedgerError, parseAmount, type Journal } from '../starter/src/ledger.ts';

/** 内存日志：可被多个实例共享，模拟同一本持久日志。 */
function memoryJournal(initial: string[] = []): Journal & { entries: string[] } {
  const entries = [...initial];
  return {
    entries,
    append(entry) { entries.push(entry); },
    read() { return [...entries]; },
  };
}

test('hidden/apply-appends-accumulates-and-advances-checkpoint', () => {
  // 契约第 1 条：每个金额追加到日志、累加余额、checkpoint 推进到已入账条数。
  const journal = memoryJournal();
  const store = new CheckpointStore(journal);
  assert.equal(store.balance, 0, '初始余额不是 0');
  assert.equal(store.checkpoint, 0, '初始检查点不是 0');
  assert.equal(store.apply([10, 20, 30]), 60, 'apply 返回值不对');
  assert.equal(store.balance, 60);
  assert.equal(store.checkpoint, 3, 'checkpoint 不是 3');
  assert.deepEqual(journal.entries, ['10', '20', '30'], '日志内容不对：' + JSON.stringify(journal.entries));
  // 继续 apply：checkpoint 继续前进。
  assert.equal(store.apply([-5]), 55);
  assert.equal(store.checkpoint, 4);
  assert.equal(journal.entries.length, 4);
  // 空数组是合法的空操作。
  assert.equal(store.apply([]), 55, '空 apply 改变了余额');
  assert.equal(store.checkpoint, 4, '空 apply 推进了检查点');
  assert.equal(journal.entries.length, 4, '空 apply 写了日志');
});

test('hidden/recover-is-idempotent-across-repeated-calls', () => {
  // 契约第 2 条：recover 只重放检查点之后的条目；重复调用余额不变。
  const journal = memoryJournal();
  const store = new CheckpointStore(journal);
  store.apply([10, 20]);
  assert.equal(store.balance, 30);
  assert.equal(store.checkpoint, 2);
  // 连续多次 recover：余额与检查点都不得变。
  for (let round = 0; round < 5; round += 1) {
    assert.equal(store.recover(), 30, '第 ' + round + ' 次 recover 余额变了');
    assert.equal(store.balance, 30, '第 ' + round + ' 次 recover 后 balance 变了');
    assert.equal(store.checkpoint, 2, '第 ' + round + ' 次 recover 后 checkpoint 变了');
  }
  // 关键反例：旧的实现每次都从 0 重放，余额会逐次翻倍。
  assert.equal(store.balance, 30, '余额被重复计入');
});

test('hidden/restart-on-same-journal-replays-each-entry-once', () => {
  // 契约第 3 条：新实例从同一本日志恢复，余额与检查点等于日志全部有效内容。
  const journal = memoryJournal();
  const first = new CheckpointStore(journal);
  first.apply([100, 200, 300]);
  assert.equal(first.balance, 600);
  // 模拟进程重启：新建实例读同一本日志。
  const restarted = new CheckpointStore(journal);
  assert.equal(restarted.balance, 600, '重启后余额不对');
  assert.equal(restarted.checkpoint, 3, '重启后检查点不对');
  // 再重启一次：仍然不能翻倍。
  const again = new CheckpointStore(journal);
  assert.equal(again.balance, 600, '二次重启后余额翻倍了');
  assert.equal(again.checkpoint, 3);
  // 原实例仍然独立工作。
  assert.equal(first.apply([100]), 700);
  assert.equal(first.checkpoint, 4);
  // 新实例恢复能看到新增条目。
  const third = new CheckpointStore(journal);
  assert.equal(third.balance, 700, '新实例没有看到追加的条目');
  assert.equal(third.checkpoint, 4);
});

test('hidden/entries-appended-by-others-are-replayed-once', () => {
  // 契约第 2、3 条：别人追加的日志条目，恢复时只计入一次。
  const journal = memoryJournal();
  const store = new CheckpointStore(journal);
  store.apply([10]);
  assert.equal(store.balance, 10);
  assert.equal(store.checkpoint, 1);
  // 另一个写者直接往日志追加（不经过本实例）。
  journal.entries.push('5');
  journal.entries.push('-3');
  assert.equal(journal.entries.length, 3);
  // 本实例恢复：只重放检查点之后的两条。
  assert.equal(store.recover(), 12, '恢复没有把他人追加的条目算进去');
  assert.equal(store.balance, 12);
  assert.equal(store.checkpoint, 3, '恢复后检查点不对');
  // 再次 recover：不得重复计入。
  assert.equal(store.recover(), 12, '他人追加的条目被重复计入');
  assert.equal(store.checkpoint, 3);
  // 他人继续追加并恢复。
  journal.entries.push('7');
  assert.equal(store.recover(), 19);
  assert.equal(store.checkpoint, 4);
  assert.equal(store.recover(), 19, '连续恢复重复计入');
});

test('hidden/invalid-entries-are-rejected-with-the-offending-text', () => {
  // 契约第 4 条：非整数条目抛 LedgerError，entry 为该条目。
  // parseAmount 直接检查。注意 Number('') === 0、Number(' ') === 0：
  // 空白串会被当作 0，这是既定解析规则，契约只要求「非整数条目抛错」。
  for (const bad of ['abc', '1.5', 'NaN', 'Infinity', '-Infinity', '1 2', '+', '-', '1,000', '1/2', 'null', 'true']) {
    assert.throws(() => parseAmount(bad), (error: unknown) => error instanceof LedgerError && error.entry === bad,
      'entry=' + JSON.stringify(bad));
  }
  // 合法形式。
  assert.equal(parseAmount('0'), 0);
  assert.equal(parseAmount('42'), 42);
  assert.equal(parseAmount('-7'), -7);
  assert.equal(parseAmount('9007199254740991'), Number.MAX_SAFE_INTEGER);
  // 凡是 Number 能得出整数的形式都接受（契约只要求「非整数抛错」）。
  assert.equal(parseAmount(''), 0);
  assert.equal(parseAmount(' '), 0);
  assert.equal(parseAmount('1e3'), 1000);
  assert.equal(parseAmount('0x10'), 16);

  // 日志里混入非法条目：构造与恢复都必须抛出，且带出该条目。
  const corrupt = memoryJournal(['10', 'oops', '20']);
  assert.throws(() => new CheckpointStore(corrupt),
    (error: unknown) => error instanceof LedgerError && error.entry === 'oops');
  // 恢复失败不得让已确认状态被污染：balance 保持 0（未发布）。
  assert.throws(() => new CheckpointStore(memoryJournal(['bad'])), LedgerError);
  // 第一条就非法。
  assert.throws(() => new CheckpointStore(memoryJournal(['bad', '1'])),
    (error: unknown) => error instanceof LedgerError && error.entry === 'bad');
});

test('hidden/checkpoint-only-advances-and-matches-journal-length', () => {
  // 契约第 5 条：checkpoint 只前进，且等于已入账条数。
  const journal = memoryJournal();
  const store = new CheckpointStore(journal);
  const seen: number[] = [];
  for (const entries of [[1], [2, 3], [], [-4], [5, 6, 7]]) {
    store.apply(entries);
    seen.push(store.checkpoint);
    assert.equal(store.checkpoint, journal.entries.length, 'checkpoint 与日志长度不一致');
  }
  // 单调不减。
  for (let index = 1; index < seen.length; index += 1) {
    assert.ok(seen[index]! >= seen[index - 1]!, 'checkpoint 回退了：' + seen.join(','));
  }
  assert.deepEqual(seen, [1, 3, 3, 4, 7], 'checkpoint 序列不对：' + seen.join(','));
  // 恢复他人追加后，checkpoint 仍等于日志长度。
  journal.entries.push('8');
  store.recover();
  assert.equal(store.checkpoint, 8);
  assert.equal(store.balance, 1 + 2 + 3 - 4 + 5 + 6 + 7 + 8);
});
