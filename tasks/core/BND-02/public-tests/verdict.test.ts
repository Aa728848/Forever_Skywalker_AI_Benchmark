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

test('public/parses-single-json-block', () => {
  const verdict = parseVerdict('评审结论如下。\n' + fence(verdictBody()) + '\n以上。');
  assert.equal(verdict.winner, 'candidate-a');
  assert.deepEqual(verdict.scores, { 'candidate-a': 88, 'candidate-b': 71 });
  assert.equal(verdict.rationale, '结论清晰');
});

test('public/prose-braces-are-ignored', () => {
  const raw = '参考 {a: 1} 的写法：\n' + fence(verdictBody({ rationale: '含 } 与 ``` 的说明' })) + '\n结束 }';
  const verdict = parseVerdict(raw);
  assert.equal(verdict.winner, 'candidate-a');
  assert.equal(verdict.rationale, '含 } 与 ``` 的说明');
});

test('public/rejects-missing-block', () => {
  assert.equal(codeOf(() => parseVerdict(verdictBody())), 'missing-block');
  assert.equal(codeOf(() => parseVerdict('没有任何围栏块的纯文本。')), 'missing-block');
});

test('public/rejects-multiple-blocks', () => {
  const raw = fence(verdictBody()) + '\n' + fence(verdictBody({ winner: 'candidate-b' }));
  assert.equal(codeOf(() => parseVerdict(raw)), 'multiple-blocks');
});

test('public/validates-shape-and-scores', () => {
  assert.equal(codeOf(() => parseVerdict(fence('{ 不是 JSON }'))), 'invalid-json');
  assert.equal(codeOf(() => parseVerdict(fence(JSON.stringify({ scores: {}, rationale: 'x' })))), 'invalid-shape');
  assert.equal(codeOf(() => parseVerdict(fence(JSON.stringify({ winner: 'a', scores: { a: 101 }, rationale: 'x' })))), 'invalid-shape');
  assert.equal(codeOf(() => parseVerdict(fence(JSON.stringify({ winner: 'a', scores: { a: '90' }, rationale: 'x' })))), 'invalid-shape');
});

test('public/tool-arguments-string-form', () => {
  const body = JSON.stringify([{ name: 'search', arguments: JSON.stringify({ q: '深层' }) }]);
  const calls = parseToolCalls(fence(body));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.arguments, { q: '深层' });
});

test('public/tool-calls-preserve-order', () => {
  const body = JSON.stringify([
    { name: 'first', arguments: { index: 1 } },
    { name: 'second', arguments: { index: 2 } },
    { name: 'third', arguments: { index: 3 } },
  ]);
  const calls = parseToolCalls(fence(body));
  assert.deepEqual(calls.map(call => call.name), ['first', 'second', 'third']);
  assert.deepEqual(calls.map(call => call.arguments.index), [1, 2, 3]);
});

test('public/bounded-on-large-input', () => {
  const rationale = '说明'.repeat(100000);
  const started = process.hrtime.bigint();
  const verdict = parseVerdict(fence(verdictBody({ rationale })));
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(verdict.rationale.length, rationale.length);
  assert.ok(elapsedMs < 10000, '大输入解析耗时过长：' + elapsedMs + 'ms');
});
