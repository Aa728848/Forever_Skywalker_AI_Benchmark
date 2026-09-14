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

test('hidden/parses-and-sums', () => {
  assert.deepEqual(parseLine('a=12'), { key: 'a', value: 12 });
  assert.deepEqual(parseLine('b=-3'), { key: 'b', value: -3 });
  assert.deepEqual(summarizeRecords(['a=1', 'b=2', 'a=3', 'b=-5']), { a: 4, b: -3 });
  assert.deepEqual(summarizeRecords([]), {});
});

test('hidden/rejects-invalid-lines', () => {
  assert.throws(() => parseLine('nope'), (error: unknown) => error instanceof InvalidLineError && error.index === 0);
  assert.throws(() => summarizeRecords(['a=1', 'bad line']), (error: unknown) => error instanceof InvalidLineError && error.index === 1);
  assert.throws(() => parseLine('a=1.5'), InvalidLineError);
  assert.throws(() => parseLine('=1'), InvalidLineError);
});

test('hidden/matches-naive-reference', () => {
  const lines = sample(200);
  const expected: Record<string, number> = {};
  for (const line of lines) {
    const [key, value] = line.split('=');
    expected[key!] = (expected[key!] ?? 0) + Number(value);
  }
  assert.deepEqual(summarizeRecords(lines), expected);
});

test('hidden/scaling-ratio-is-subquadratic', () => {
  const small = counting(sample(400));
  summarizeRecords(small.lines);
  const large = counting(sample(1600));
  summarizeRecords(large.lines);
  const ratio = large.accesses() / small.accesses();
  assert.ok(large.accesses() <= 8 * 1600, '访问次数必须线性，实际 ' + large.accesses());
  assert.ok(ratio <= 8, '4 倍规模下访问次数比值必须亚二次，实际 ' + ratio.toFixed(2));
});

test('hidden/does-not-mutate-input', () => {
  const lines = sample(50);
  const snapshot = JSON.stringify(lines);
  const first = summarizeRecords(lines);
  assert.equal(JSON.stringify(lines), snapshot);
  assert.deepEqual(summarizeRecords(lines), first);
});
