import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamCollector, type StreamEvent } from '../starter/src/stream.ts';

const data = (value: number): StreamEvent => ({ kind: 'data', value });
const end: StreamEvent = { kind: 'end' };
const error = (message: string): StreamEvent => ({ kind: 'error', message });

test('public/collects-data-until-end', () => {
  const collector = new StreamCollector();
  collector.push(data(2));
  collector.push(data(3));
  collector.push(end);
  assert.deepEqual(collector.summary, { total: 5, count: 2, ended: true, error: null });
});

test('public/ignores-events-after-end', () => {
  const collector = new StreamCollector();
  collector.push(data(1));
  collector.push(end);
  collector.push(data(100));
  collector.push(error('迟到错误'));
  collector.timeout();
  assert.deepEqual(collector.summary, { total: 1, count: 1, ended: true, error: null });
});

test('public/ignores-events-after-error', () => {
  const collector = new StreamCollector();
  collector.push(data(1));
  collector.push(error('第一条错误'));
  collector.push(error('第二条错误'));
  collector.push(data(50));
  collector.push(end);
  assert.deepEqual(collector.summary, { total: 1, count: 1, ended: false, error: '第一条错误' });
});

test('public/timeout-freezes-stream', () => {
  const collector = new StreamCollector({ timeoutMs: 20 });
  collector.push(data(4));
  collector.timeout();
  collector.timeout();
  collector.push(data(6));
  collector.push(end);
  assert.equal(collector.timeoutMs, 20);
  assert.deepEqual(collector.summary, { total: 4, count: 1, ended: false, error: '超时' });
});

test('public/summary-is-a-snapshot', () => {
  const collector = new StreamCollector();
  collector.push(data(1));
  const first = collector.summary;
  collector.push(data(1));
  assert.equal(first.total, 1);
  assert.equal(collector.summary.total, 2);
});
