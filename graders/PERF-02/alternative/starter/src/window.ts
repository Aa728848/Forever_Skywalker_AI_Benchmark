export interface Row {
  readonly id: string;
  readonly value: number;
}

export interface RenderWindow {
  readonly offset: number;
  readonly size: number;
}

export interface RenderedRange {
  readonly start: number;
  readonly end: number;
  readonly items: readonly Row[];
}

/** 替代实现：按窗口边界直接构造数组（Array.from + 映射窗口下标）。 */
export function updateRows(rows: readonly Row[], patch: Row, window: RenderWindow): RenderedRange {
  if (!Number.isInteger(window.offset) || window.offset < 0) throw new RangeError('offset 必须是非负整数');
  if (!Number.isInteger(window.size) || window.size < 1) throw new RangeError('size 必须是正整数');
  const start = window.offset > rows.length ? rows.length : window.offset;
  const end = start + window.size > rows.length ? rows.length : start + window.size;
  const count = end > start ? end - start : 0;
  const items = Array.from({ length: count }, (_unused, index) => {
    const row = rows[start + index] as Row;
    return row.id === patch.id ? { id: row.id, value: patch.value } : row;
  });
  return { start, end, items };
}
