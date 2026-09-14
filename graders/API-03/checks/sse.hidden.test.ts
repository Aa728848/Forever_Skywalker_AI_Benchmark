import test from 'node:test';
import assert from 'node:assert/strict';
import { MalformedFrameError, SequenceGapError, SseDecoder } from '../starter/src/sse.ts';

const frame = (id: number, data: string): string => 'id: ' + id + '\ndata: ' + data + '\n\n';

function failureOf(run: () => unknown): string {
  try { run(); return 'ok'; } catch (error) {
    if (error instanceof SequenceGapError) return 'gap:' + error.expected + '->' + error.received;
    if (error instanceof MalformedFrameError) return 'malformed';
    return 'other:' + String(error);
  }
}

test('hidden/parses-single-chunk-frames', () => {
  const decoder = new SseDecoder();
  const events = decoder.push(frame(1, 'a') + frame(2, 'b'));
  assert.deepEqual(events, [{ id: 1, data: 'a' }, { id: 2, data: 'b' }]);
  assert.equal(decoder.lastId, 2);
});

test('hidden/buffers-partial-frames-across-chunks', () => {
  const decoder = new SseDecoder();
  const whole = frame(1, 'hello');
  assert.deepEqual(decoder.push(whole.slice(0, 6)), []);
  assert.deepEqual(decoder.push(whole.slice(6)), [{ id: 1, data: 'hello' }]);
  assert.deepEqual(decoder.end(), []);
});

test('hidden/rejects-sequence-gap', () => {
  const decoder = new SseDecoder();
  decoder.push(frame(1, 'a'));
  assert.equal(failureOf(() => decoder.push(frame(3, 'c'))), 'gap:2->3');
  assert.equal(decoder.lastId, 1, '失败不得推进 lastId');
});

test('hidden/ignores-replayed-events', () => {
  const decoder = new SseDecoder();
  decoder.push(frame(1, 'a') + frame(2, 'b'));
  assert.deepEqual(decoder.push(frame(2, 'b') + frame(1, 'a')), []);
  assert.deepEqual(decoder.push(frame(3, 'c')), [{ id: 3, data: 'c' }]);
  assert.equal(decoder.lastId, 3);
});

test('hidden/end-flushes-last-frame-and-rejects-malformed', () => {
  const decoder = new SseDecoder();
  decoder.push('id: 1\ndata: tail');
  assert.deepEqual(decoder.end(), [{ id: 1, data: 'tail' }]);
  const malformed = new SseDecoder();
  assert.equal(failureOf(() => malformed.push('data: no-id\n\n')), 'malformed');
  assert.equal(failureOf(() => new SseDecoder().push('id: 1\n\n')), 'malformed');
});
