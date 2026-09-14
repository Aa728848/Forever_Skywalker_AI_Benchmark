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

export interface MountedList {
  applyPatch(patch: Row): void;
  setWindow(window: RenderWindow): void;
  dispose(): void;
}

/** 将可见窗口挂载到专属容器，点击一行按钮将该行值加一。 */
export function mountList(container: HTMLElement, rows: readonly Row[], initialWindow: RenderWindow): MountedList {
  let source: readonly Row[] | null = rows;
  let window = initialWindow;
  let visible: readonly Row[] = [];
  const patches = new Map<string, Row>();
  const render = () => {
    if (source === null) throw new Error('list disposed');
    visible = updateRows(source, source[window.offset] ?? { id: '', value: 0 }, window).items.map(row => patches.get(row.id) ?? row);
    // 缺陷：每次局部更新都重建整个可见DOM，破坏其他行的节点身份与焦点。
    container.replaceChildren(...visible.map(row => {
      const item = document.createElement('div');
      item.setAttribute('role', 'listitem');
      item.dataset.rowId = row.id;
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.rowId = row.id;
      button.textContent = row.id + ': ' + row.value;
      item.append(button);
      return item;
    }));
  };
  const api: MountedList = {
    applyPatch(patch) {
      if (source === null) throw new Error('list disposed');
      if (!visible.some(row => row.id === patch.id)) return;
      patches.set(patch.id, { ...patch });
      render();
    },
    setWindow(next) {
      if (source === null) throw new Error('list disposed');
      updateRows(source, source[next.offset] ?? { id: '', value: 0 }, next);
      window = next;
      render();
    },
    dispose() {
      container.removeEventListener('click', click);
      container.replaceChildren();
      source = null;
      visible = [];
      patches.clear();
    },
  };
  const click = (event: Event) => {
    const button = event.target instanceof Element ? event.target.closest('button[data-row-id]') : null;
    if (button === null || !container.contains(button)) return;
    const row = visible.find(item => item.id === (button as HTMLElement).dataset.rowId);
    if (row !== undefined) api.applyPatch({ id: row.id, value: row.value + 1 });
  };
  container.setAttribute('role', 'list');
  render();
  container.addEventListener('click', click);
  return api;
}
