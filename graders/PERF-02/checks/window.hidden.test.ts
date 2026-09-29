import test from 'node:test';
import assert from 'node:assert/strict';
import { updateRows, type RenderWindow, type Row } from '../starter/src/window.ts';

function rowsOf(count: number, prefix = 'row-'): Row[] {
  return Array.from({ length: count }, (_unused, index) => ({ id: prefix + index, value: index }));
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

const idsOf = (items: readonly Row[]): string[] => items.map(row => row.id);

test('hidden/window-is-truncated-to-list-end-at-every-offset', () => {
  // 契约第 1 条：返回 [start, end)，截断到列表末尾；start 越界时 items 为空。
  const rows = rowsOf(4);
  // 窗口正好贴到末尾。
  assert.deepEqual(updateRows(rows, { id: 'x', value: 0 }, { offset: 2, size: 2 }),
    { start: 2, end: 4, items: [{ id: 'row-2', value: 2 }, { id: 'row-3', value: 3 }] });
  // 窗口越过末尾：end 截断到长度。
  assert.deepEqual(updateRows(rows, { id: 'x', value: 0 }, { offset: 3, size: 10 }),
    { start: 3, end: 4, items: [{ id: 'row-3', value: 3 }] });
  // 完全越过末尾：空区间。
  assert.deepEqual(updateRows(rows, { id: 'x', value: 0 }, { offset: 4, size: 5 }),
    { start: 4, end: 4, items: [] });
  assert.deepEqual(updateRows(rows, { id: 'x', value: 0 }, { offset: 99, size: 5 }),
    { start: 4, end: 4, items: [] });
  // 空列表：任何窗口都是空区间。
  for (const window of [{ offset: 0, size: 1 }, { offset: 5, size: 3 }] as RenderWindow[]) {
    assert.deepEqual(updateRows([], { id: 'x', value: 0 }, window), { start: 0, end: 0, items: [] });
  }
  // 整表窗口：返回全部且顺序不变。
  assert.deepEqual(idsOf(updateRows(rowsOf(6), { id: 'x', value: 0 }, { offset: 0, size: 6 }).items),
    ['row-0', 'row-1', 'row-2', 'row-3', 'row-4', 'row-5']);
});

test('hidden/patch-matches-by-id-and-preserves-order', () => {
  // 契约第 2 条：按 id 命中窗口内的行并替换；顺序与原列表一致。
  const rows = rowsOf(6);
  // 命中窗口中段：只替换那一行的 value，id 不变。
  const patched = updateRows(rows, { id: 'row-2', value: 999 }, { offset: 1, size: 3 });
  assert.deepEqual(idsOf(patched.items), ['row-1', 'row-2', 'row-3'], '顺序被改动了');
  assert.deepEqual(patched.items.map(row => row.value), [1, 999, 3], '命中行的值不对');
  // 替换后的对象是 { id, value }，不是原对象引用。
  const hit = patched.items[1]!;
  assert.equal(hit.id, 'row-2');
  assert.equal(hit.value, 999);
  // 命中窗口第一行与最后一行。
  assert.equal(updateRows(rows, { id: 'row-0', value: 7 }, { offset: 0, size: 2 }).items[0]!.value, 7);
  assert.equal(updateRows(rows, { id: 'row-3', value: 8 }, { offset: 2, size: 2 }).items[1]!.value, 8);
  // patch 的 id 相同但 value 相同：仍然产出等值结果，且不改变顺序。
  const same = updateRows(rows, { id: 'row-2', value: 2 }, { offset: 0, size: 4 });
  assert.deepEqual(same.items.map(row => row.value), [0, 1, 2, 3]);
});

test('hidden/patch-outside-window-or-absent-leaves-window-untouched', () => {
  // 契约第 2 条：命中窗口之外或不存在时不做任何替换。
  const rows = rowsOf(10);
  // 窗口 [2,5)，patch 命中窗口外的前一行与后一行。
  for (const id of ['row-1', 'row-5', 'row-9']) {
    const range = updateRows(rows, { id, value: 999 }, { offset: 2, size: 3 });
    assert.deepEqual(range.items.map(row => row.value), [2, 3, 4], '窗口外的 ' + id + ' 影响了窗口');
  }
  // 完全不存在的 id。
  const missing = updateRows(rows, { id: 'nope', value: 999 }, { offset: 0, size: 3 });
  assert.deepEqual(missing.items.map(row => row.value), [0, 1, 2]);
  // 空串 id 也是合法 id，不得被当成「缺失」。
  const blank = [{ id: '', value: 1 }, { id: 'a', value: 2 }];
  const hit = updateRows(blank, { id: '', value: 42 }, { offset: 0, size: 2 });
  assert.equal(hit.items[0]!.value, 42, '空串 id 没有被匹配');
  assert.equal(hit.items[1]!.value, 2);
  // Unicode 与 HTML 字符 id 正常匹配。
  const exotic = [{ id: '<b>x</b>', value: 1 }, { id: '中文🚀', value: 2 }];
  assert.equal(updateRows(exotic, { id: '中文🚀', value: 5 }, { offset: 0, size: 2 }).items[1]!.value, 5);
});

test('hidden/access-count-is-bounded-and-independent-of-length', () => {
  // 契约第 3 条：访问次数（含 length）与 size 同阶，常数 ≤ 4×size + 8，且不随列表长度增长。
  const window: RenderWindow = { offset: 10, size: 5 };
  const baseline = counting(rowsOf(100));
  updateRows(baseline.rows, { id: 'row-10', value: 1 }, window);
  const small = baseline.accesses();
  for (const length of [1000, 10000, 100000]) {
    const measured = counting(rowsOf(length));
    updateRows(measured.rows, { id: 'row-10', value: 1 }, window);
    const count = measured.accesses();
    assert.ok(count <= 4 * window.size + 8,
      length + ' 行：访问 ' + count + ' 次，超过 4×size+8=' + (4 * window.size + 8));
    // 长度变化时访问次数不得增长。
    assert.ok(count <= small, length + ' 行：访问次数 ' + count + ' 比 100 行的 ' + small + ' 还多');
  }
  // 窗口大小不同：访问次数随之变化，但仍不随列表长度增长。
  for (const size of [1, 3, 10, 50]) {
    const smallList = counting(rowsOf(200));
    updateRows(smallList.rows, { id: 'x', value: 0 }, { offset: 5, size });
    const largeList = counting(rowsOf(20000));
    updateRows(largeList.rows, { id: 'x', value: 0 }, { offset: 5, size });
    assert.ok(largeList.accesses() <= 4 * size + 8, 'size=' + size + ' 超过上限：' + largeList.accesses());
    assert.ok(largeList.accesses() <= smallList.accesses(), 'size=' + size + ' 访问次数随长度增长');
  }
  // 空列表的访问次数同样受限。
  const empty = counting([]);
  updateRows(empty.rows, { id: 'x', value: 0 }, { offset: 0, size: 10 });
  assert.ok(empty.accesses() <= 4 * 10 + 8, '空列表访问次数超限：' + empty.accesses());
});

test('hidden/invalid-window-throws-rangeerror-without-side-effects', () => {
  // 契约第 4 条：offset 必须是非负整数、size 必须是正整数，否则 RangeError。
  const rows = rowsOf(5);
  const invalid: Array<[number, number]> = [
    [-1, 2], [0, 0], [0, -1], [1.5, 2], [0, 2.5],
    [Number.NaN, 2], [0, Number.NaN], [Number.POSITIVE_INFINITY, 2], [0, Number.POSITIVE_INFINITY],
  ];
  for (const [offset, size] of invalid) {
    assert.throws(() => updateRows(rows, { id: 'x', value: 0 }, { offset, size }), RangeError,
      'offset=' + String(offset) + ' size=' + String(size));
  }
  // 合法边界。
  assert.doesNotThrow(() => updateRows(rows, { id: 'x', value: 0 }, { offset: 0, size: 1 }));
  assert.doesNotThrow(() => updateRows(rows, { id: 'x', value: 0 }, { offset: 0, size: rows.length }));
  // 抛错时不得修改输入。
  const snapshot = JSON.stringify(rows);
  assert.throws(() => updateRows(rows, { id: 'x', value: 0 }, { offset: -1, size: 1 }), RangeError);
  assert.equal(JSON.stringify(rows), snapshot, '抛错时修改了输入');
});

test('hidden/input-rows-are-never-mutated', () => {
  // 契约第 5 条：不得修改输入数组。
  const rows = rowsOf(20);
  const snapshot = JSON.stringify(rows);
  const copy = rows.slice();
  for (const [offset, size] of [[0, 5], [10, 5], [18, 10], [25, 3]] as Array<[number, number]>) {
    const range = updateRows(rows, { id: 'row-' + (offset + 1), value: 777 }, { offset, size });
    // 结果里的命中行是新值，但原数组不变。
    for (const item of range.items) {
      if (item.id === 'row-' + (offset + 1)) assert.equal(item.value, 777, '命中行没有替换');
    }
  }
  assert.equal(JSON.stringify(rows), snapshot, '输入数组被修改了');
  assert.deepEqual(rows, copy, '输入数组内容变了');
  assert.equal(rows.length, 20);
  // 契约第 5 条只要求「不修改输入数组」：未命中行复用原对象是合法且更高效的做法，
  // 这里只验证结果与输入在值上仍一致，不要求对象身份不同。
  const range = updateRows(rows, { id: 'x', value: 0 }, { offset: 0, size: 3 });
  assert.deepEqual(range.items.map(row => row.value), [0, 1, 2], '未命中行的值被改动了');
  assert.equal(JSON.stringify(rows), snapshot, '读取结果后输入变了');
});
