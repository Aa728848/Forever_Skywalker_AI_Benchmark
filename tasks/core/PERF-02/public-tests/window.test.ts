import test from 'node:test';
import assert from 'node:assert/strict';
import { updateRows, type Row } from '../starter/src/window.ts';

function rowsOf(count: number): Row[] {
  return Array.from({ length: count }, (_unused, index) => ({ id: 'row-' + index, value: index }));
}

/** 统计对输入数组的元素访问次数（含 length），用于断言复杂度而不是计时。 */
function counting(rows: Row[]) {
  let accesses = 0;
  const proxy = new Proxy(rows, {
    get(target, property, receiver) {
      accesses += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  return { rows: proxy as readonly Row[], accesses: () => accesses };
}

function failureOf(run: () => unknown): string {
  try { run(); return 'ok'; } catch (error) {
    return error instanceof RangeError ? 'range' : 'other:' + String(error);
  }
}

test('public/returns-window', () => {
  const range = updateRows(rowsOf(1000), { id: 'row-500', value: 42 }, { offset: 10, size: 3 });
  assert.equal(range.start, 10);
  assert.equal(range.end, 13);
  assert.deepEqual(range.items.map(row => row.id), ['row-10', 'row-11', 'row-12']);
});

test('public/applies-patch-inside-window', () => {
  const source = rowsOf(10);
  const range = updateRows(source, { id: 'row-2', value: 99 }, { offset: 1, size: 3 });
  assert.deepEqual(range.items.map(row => row.value), [1, 99, 3]);
  assert.equal(source[2]?.value, 2, '不得修改输入数组');
  const outside = updateRows(source, { id: 'row-9', value: 99 }, { offset: 0, size: 2 });
  assert.deepEqual(outside.items.map(row => row.value), [0, 1]);
});
test('public/does-not-scan-whole-list', () => {
  const counted = counting(rowsOf(4000));
  const range = updateRows(counted.rows, { id: 'row-3000', value: 1 }, { offset: 3000, size: 5 });
  assert.equal(range.items.length, 5);
  assert.ok(counted.accesses() <= 4 * 5 + 8, '访问次数必须与窗口大小同阶，实际 ' + counted.accesses());
});

test('public/rejects-invalid-window', () => {
  assert.equal(failureOf(() => updateRows(rowsOf(5), { id: 'x', value: 1 }, { offset: -1, size: 2 })), 'range');
  assert.equal(failureOf(() => updateRows(rowsOf(5), { id: 'x', value: 1 }, { offset: 0, size: 0 })), 'range');
  assert.equal(failureOf(() => updateRows(rowsOf(5), { id: 'x', value: 1 }, { offset: 1.5, size: 2 })), 'range');
});

test('public/beyond-end-returns-empty-items', () => {
  const range = updateRows(rowsOf(4), { id: 'row-0', value: 7 }, { offset: 10, size: 5 });
  assert.deepEqual(range, { start: 4, end: 4, items: [] });
});
