import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamCollector, type StreamEvent } from '../starter/src/stream.ts';

const data = (value: number): StreamEvent => ({ kind: 'data', value });
const end = (): StreamEvent => ({ kind: 'end' });
const error = (message: string): StreamEvent => ({ kind: 'error', message });

test('hidden/collects-data-until-end', () => {
  const collector = new StreamCollector();
  // 契约第 1 条：total 只累加 value，count 累加次数。
  collector.push(data(1));
  collector.push(data(2));
  collector.push(data(10));
  assert.deepEqual(collector.summary, { total: 13, count: 3, ended: false, error: null });
  // 零值与负值都照常累加（契约没有排除它们）。
  collector.push(data(0));
  collector.push(data(-5));
  assert.deepEqual(collector.summary, { total: 8, count: 5, ended: false, error: null });
});

test('hidden/ignores-events-after-end', () => {
  const collector = new StreamCollector();
  collector.push(data(3));
  collector.push(end());
  const frozen = collector.summary;
  // 契约第 3 条：终态后任何 push 与 timeout 一律忽略。
  collector.push(data(100));
  collector.push(end());
  collector.push(error('late'));
  collector.timeout();
  assert.deepEqual(collector.summary, frozen, 'end 之后结果被改动了');
  assert.equal(collector.summary.ended, true);
  assert.equal(collector.summary.error, null, 'end 之后的错误覆盖了结果');
  assert.equal(collector.summary.count, 1);
});

test('hidden/ignores-events-after-error', () => {
  const collector = new StreamCollector();
  collector.push(data(4));
  collector.push(error('FIRST'));
  const frozen = collector.summary;
  collector.push(data(50));
  // 契约第 2 条：保留**第一条**错误消息。
  collector.push(error('SECOND'));
  collector.push(end());
  collector.timeout();
  assert.deepEqual(collector.summary, frozen, 'error 之后结果被改动了');
  assert.equal(collector.summary.error, 'FIRST', '错误消息被覆盖了');
  assert.equal(collector.summary.ended, false, 'error 之后又被标记为结束');
});

test('hidden/timeout-freezes-stream', () => {
  const collector = new StreamCollector();
  collector.push(data(7));
  collector.timeout();
  // 契约第 2 条：timeout 使 error 为超时，但���置 ended。
  assert.deepEqual(collector.summary, { total: 7, count: 1, ended: false, error: '超时' });
  const frozen = collector.summary;
  // 契约第 3、4 条：终态后一切忽略，timeout 幂等。
  collector.push(data(999));
  collector.push(end());
  collector.push(error('late'));
  collector.timeout();
  collector.timeout();
  assert.deepEqual(collector.summary, frozen, 'timeout 之后结果被改动了');
  assert.equal(collector.summary.ended, false, 'timeout 不应置 ended');
});

test('hidden/summary-is-a-snapshot', () => {
  const collector = new StreamCollector();
  collector.push(data(1));
  const snapshot = collector.summary;
  // 契约第 5 条：取出的对象不随后续 push 改变。
  collector.push(data(2));
  collector.push(error('later'));
  assert.deepEqual(snapshot, { total: 1, count: 1, ended: false, error: null }, '快照被后续 push 改写了');
  assert.deepEqual(collector.summary, { total: 3, count: 2, ended: false, error: 'later' });
  // 两次读取返回不同对象。
  const again = collector.summary;
  assert.notEqual(again, snapshot, '两次读取返回了同一对象');
  assert.deepEqual(again, collector.summary);
});

test('hidden/first-terminal-wins-across-all-three', () => {
  // 三种终态里最先到的那个决定结果，其余一律忽略。
  const build = (label: 'end' | 'error' | 'timeout') => {
    const collector = new StreamCollector();
    collector.push(data(1));
    if (label === 'end') {
      collector.push(end());
      collector.push(error('x'));
      collector.push(data(9));
      return { collector, ended: true, error: null as string | null };
    }
    if (label === 'error') {
      collector.push(error('A'));
      collector.push(error('B'));
      collector.push(end());
      return { collector, ended: false, error: 'A' };
    }
    collector.timeout();
    collector.push(data(9));
    collector.push(end());
    return { collector, ended: false, error: '超时' };
  };
  for (const label of ['end', 'error', 'timeout'] as const) {
    const { collector, ended, error: expected } = build(label);
    assert.equal(collector.summary.ended, ended, label);
    assert.equal(collector.summary.error, expected, label);
    assert.equal(collector.summary.count, 1, label + '：终态前的 data 丢了');
    assert.equal(collector.summary.total, 1, label + '：终态前的 data 丢了');
  }
});

test('hidden/timeout-ms-defaults-and-is-readable', () => {
  // 契约第 6 条：缺省 5000，构造参数可覆盖，只作为配置读出。
  assert.equal(new StreamCollector().timeoutMs, 5000);
  assert.equal(new StreamCollector({}).timeoutMs, 5000);
  assert.equal(new StreamCollector({ timeoutMs: 1 }).timeoutMs, 1);
  assert.equal(new StreamCollector({ timeoutMs: 0 }).timeoutMs, 0);
  assert.equal(new StreamCollector({ timeoutMs: 999999 }).timeoutMs, 999999);
  // 读出 timeoutMs 不得改变汇总。
  const collector = new StreamCollector({ timeoutMs: 10 });
  collector.push(data(1));
  void collector.timeoutMs;
  assert.deepEqual(collector.summary, { total: 1, count: 1, ended: false, error: null });
});

test('hidden/end-and-timeout-do-not-cross-contaminate', () => {
  // end 之后 timeout：ended 保持 true 且 error 仍为 null。
  const collector = new StreamCollector();
  collector.push(data(2));
  collector.push(end());
  collector.timeout();
  assert.deepEqual(collector.summary, { total: 2, count: 1, ended: true, error: null });
  // 反过来 timeout 之后 push(end)：ended 不得被置位。
  const other = new StreamCollector();
  other.timeout();
  other.push(end());
  assert.equal(other.summary.ended, false, 'timeout 之后被标记为结束');
  assert.equal(other.summary.error, '超时');
});
