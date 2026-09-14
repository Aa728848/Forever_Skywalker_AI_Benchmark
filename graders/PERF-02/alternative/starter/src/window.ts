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

export interface MountedList {
  applyPatch(patch: Row): void;
  setWindow(window: RenderWindow): void;
  dispose(): void;
}

/** 替代实现：按当前DOM索引保留重叠行，不维护额外的节点缓存。 */
export function mountList(container: HTMLElement, rows: readonly Row[], initialWindow: RenderWindow): MountedList {
  let source: readonly Row[] | null = rows;
  let viewport = initialWindow;
  let current: readonly Row[] = [];
  const changes = new Map<string, Row>();
  const redraw = () => {
    if (source === null) throw new Error('list disposed');
    current = updateRows(source, source[viewport.offset] ?? { id: '', value: 0 }, viewport).items.map(row => changes.get(row.id) ?? row);
    const available = new Map(Array.from(container.children, element => [(element as HTMLElement).dataset.rowId!, element as HTMLElement]));
    for (const [index, row] of current.entries()) {
      let element = available.get(row.id);
      if (element === undefined) {
        element = document.createElement('div');
        element.setAttribute('role', 'listitem');
        element.dataset.rowId = row.id;
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.rowId = row.id;
        element.append(button);
      }
      const label = row.id + ': ' + row.value;
      if (element.firstElementChild!.textContent !== label) element.firstElementChild!.textContent = label;
      if (container.children[index] !== element) container.insertBefore(element, container.children[index] ?? null);
      available.delete(row.id);
    }
    for (const element of available.values()) element.remove();
  };
  const api: MountedList = {
    applyPatch(patch) {
      if (source === null) throw new Error('list disposed');
      if (current.some(row => row.id === patch.id)) { changes.set(patch.id, { ...patch }); redraw(); }
    },
    setWindow(next) {
      if (source === null) throw new Error('list disposed');
      updateRows(source, source[next.offset] ?? { id: '', value: 0 }, next);
      viewport = next;
      redraw();
    },
    dispose() {
      container.removeEventListener('click', onClick);
      container.replaceChildren();
      source = null;
      current = [];
      changes.clear();
    },
  };
  const onClick = (event: Event) => {
    const target = event.target instanceof Element ? event.target.closest('button[data-row-id]') : null;
    if (target === null || !container.contains(target)) return;
    const row = current.find(item => item.id === (target as HTMLElement).dataset.rowId);
    if (row !== undefined) api.applyPatch({ id: row.id, value: row.value + 1 });
  };
  container.replaceChildren();
  container.setAttribute('role', 'list');
  redraw();
  container.addEventListener('click', onClick);
  return api;
}
