import test from 'node:test';
import assert from 'node:assert/strict';
import { VerdictFormatError, parseToolCalls, parseVerdict } from '../starter/src/verdict.ts';

function fence(body: string, info = 'json'): string {
  return '```' + info + '\n' + body + '\n```';
}

function verdictBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ winner: 'candidate-a', scores: { 'candidate-a': 88, 'candidate-b': 71 }, rationale: '结论清晰', ...overrides });
}

function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof VerdictFormatError ? error.code : 'unexpected:' + String(error);
  }
}

test('hidden/rejects-unterminated-json-fence', () => {
  assert.equal(codeOf(() => parseVerdict('```json\n' + verdictBody())), 'invalid-json');
});

test('hidden/non-json-fences-are-ignored', () => {
  const raw = fence('{ 只是一段说明 }', 'text') + '\n' + fence(verdictBody());
  assert.equal(parseVerdict(raw).winner, 'candidate-a');
});

test('hidden/tool-arguments-nested-escapes', () => {
  const nested = JSON.stringify({ q: '引号 \" 与 emoji 🚀', nested: { deep: [1, 2, 3] } });
  const body = JSON.stringify([{ name: 'lookup', arguments: nested }, { name: 'plain', arguments: { ok: true } }]);
  const calls = parseToolCalls(fence(body));
  assert.deepEqual(calls[0]?.arguments, { q: '引号 " 与 emoji 🚀', nested: { deep: [1, 2, 3] } });
  assert.deepEqual(calls[1]?.arguments, { ok: true });
});

test('hidden/invalid-arguments-shape', () => {
  assert.equal(codeOf(() => parseToolCalls(fence(JSON.stringify([{ name: 'x', arguments: 42 }])))), 'invalid-arguments');
  assert.equal(codeOf(() => parseToolCalls(fence(JSON.stringify([{ arguments: {} }])))), 'invalid-arguments');
  assert.equal(codeOf(() => parseToolCalls(fence(JSON.stringify([{ name: 'x', arguments: '{ 非 JSON }' }])))), 'invalid-arguments');
  assert.equal(codeOf(() => parseToolCalls(fence(JSON.stringify({ name: 'x' })))), 'invalid-arguments');
});

test('hidden/scores-boundaries', () => {
  assert.deepEqual(parseVerdict(fence(verdictBody({ scores: { a: 0, b: 100 } }))).scores, { a: 0, b: 100 });
  assert.equal(codeOf(() => parseVerdict(fence(verdictBody({ scores: { a: 100.5 } })))), 'invalid-shape');
  assert.equal(codeOf(() => parseVerdict(fence(verdictBody({ scores: { a: -1 } })))), 'invalid-shape');
});

test('hidden/does-not-mutate-input', () => {
  const raw = fence(verdictBody());
  const before = raw;
  const first = parseVerdict(raw);
  const second = parseVerdict(raw);
  assert.equal(raw, before);
  assert.deepEqual(first, second);
  assert.notEqual(first.scores, second.scores);
});
