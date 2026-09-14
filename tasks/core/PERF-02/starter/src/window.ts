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

export function updateRows(rows: readonly Row[], patch: Row, window: RenderWindow): RenderedRange {
  if (!Number.isInteger(window.offset) || window.offset < 0) throw new RangeError('offset 必须是非负整数');
  if (!Number.isInteger(window.size) || window.size < 1) throw new RangeError('size 必须是正整数');
  // 缺陷：先全量复制整张列表再切片，访问次数与列表长度成正比。
  const patched = rows.map(row => (row.id === patch.id ? { id: row.id, value: patch.value } : row));
  const start = Math.min(window.offset, patched.length);
  const end = Math.min(start + window.size, patched.length);
  return { start, end, items: patched.slice(start, end) };
}
