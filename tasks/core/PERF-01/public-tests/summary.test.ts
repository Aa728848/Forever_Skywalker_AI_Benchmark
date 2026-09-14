import test from 'node:test';
import assert from 'node:assert/strict';
import { InvalidLineError, parseLine, summarizeRecords } from '../starter/src/summary.ts';

function counting(lines: string[]) {
  let accesses = 0;
  const proxy = new Proxy(lines, {
    get(target, property, receiver) {
      accesses += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  return { lines: proxy as readonly string[], accesses: () => accesses };
}

function sample(count: number, prefix = 'k'): string[] {
  const lines: string[] = [];
  for (let index = 0; index < count; index += 1) lines.push(prefix + index + '=' + index);
  return lines;
}

test('public/parses-and-sums', () => {
  assert.deepEqual(parseLine('a=12'), { key: 'a', value: 12 });
  assert.deepEqual(parseLine('b=-3'), { key: 'b', value: -3 });
  assert.deepEqual(summarizeRecords(['a=1', 'b=2', 'a=3', 'b=-5']), { a: 4, b: -3 });
  assert.deepEqual(summarizeRecords([]), {});
});

test('public/rejects-invalid-lines', () => {
  assert.throws(() => parseLine('nope'), (error: unknown) => error instanceof InvalidLineError && error.index === 0);
  assert.throws(() => summarizeRecords(['a=1', 'bad line']), (error: unknown) => error instanceof InvalidLineError && error.index === 1);
  assert.throws(() => parseLine('a=1.5'), InvalidLineError);
  assert.throws(() => parseLine('=1'), InvalidLineError);
});

test('public/matches-naive-reference', () => {
  const lines = sample(200);
  const expected: Record<string, number> = {};
  for (const line of lines) {
    const parsed = parseLine(line);
    expected[parsed.key] = (expected[parsed.key] ?? 0) + parsed.value;
  }
  assert.deepEqual(summarizeRecords(lines), expected);
});

test('public/input-accesses-are-linear', () => {
  const counted = counting(sample(800));
  const summary = summarizeRecords(counted.lines);
  assert.equal(Object.keys(summary).length, 800);
  assert.ok(counted.accesses() <= 8 * 800, '元素访问次数必须与输入规模同阶，实际 ' + counted.accesses());
});

test('public/duplicate-heavy-input-is-linear', () => {
  const lines: string[] = [];
  for (let index = 0; index < 2000; index += 1) lines.push('same=' + (index % 7));
  const counted = counting(lines);
  assert.deepEqual(summarizeRecords(counted.lines), { same: lines.length === 0 ? 0 : lines.reduce((sum, line) => sum + Number(line.split('=')[1]), 0) });
  assert.ok(counted.accesses() <= 8 * 2000, '重复行使访问次数膨胀：' + counted.accesses());
});
