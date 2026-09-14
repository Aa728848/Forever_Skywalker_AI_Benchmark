export interface Edge {
  readonly from: string;
  readonly to: string;
}

export class CycleError extends Error {
  readonly path: readonly string[];
  constructor(path: readonly string[]) {
    super('图中存在环：' + path.join(' → '));
    this.name = 'CycleError';
    this.path = path;
  }
}

export class UnknownNodeError extends Error {
  readonly node: string;
  constructor(node: string) {
    super('边引用了未声明的节点：' + node);
    this.name = 'UnknownNodeError';
    this.node = node;
  }
}

function findCycle(nodes: readonly string[], successors: Map<string, string[]>): string[] {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (node: string): string[] | null => {
    state.set(node, 1);
    stack.push(node);
    for (const next of successors.get(node) ?? []) {
      const seen = state.get(next) ?? 0;
      if (seen === 1) return [...stack.slice(stack.indexOf(next)), next];
      if (seen === 0) {
        const found = visit(next);
        if (found !== null) return found;
      }
    }
    stack.pop();
    state.set(node, 2);
    return null;
  };
  for (const node of nodes) {
    if ((state.get(node) ?? 0) === 0) {
      const found = visit(node);
      if (found !== null) return found;
    }
  }
  return [];
}

/** 替代实现：用优先队列（每次线性取最小的可入度为零节点）。 */
export function topologicalOrder(nodes: readonly string[], edges: readonly Edge[]): readonly string[] {
  const unique = [...new Set(nodes)].sort();
  const successors = new Map<string, Set<string>>();
  const inDegree = new Map<string, number>();
  for (const node of unique) {
    successors.set(node, new Set());
    inDegree.set(node, 0);
  }
  for (const edge of edges) {
    if (!successors.has(edge.from)) throw new UnknownNodeError(edge.from);
    if (!successors.has(edge.to)) throw new UnknownNodeError(edge.to);
    const set = successors.get(edge.from) as Set<string>;
    if (set.has(edge.to)) continue;
    set.add(edge.to);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }
  const order: string[] = [];
  const remaining = new Set(unique);
  while (remaining.size > 0) {
    const candidates = [...remaining].filter(node => (inDegree.get(node) ?? 0) === 0).sort();
    if (candidates.length === 0) {
      const lists = new Map<string, string[]>();
      for (const [key, set] of successors) lists.set(key, [...set].filter(next => remaining.has(next)).sort());
      throw new CycleError(findCycle([...remaining].sort(), lists));
    }
    const node = candidates[0] as string;
    remaining.delete(node);
    order.push(node);
    for (const next of successors.get(node) as Set<string>) {
      if (remaining.has(next)) inDegree.set(next, (inDegree.get(next) ?? 0) - 1);
    }
  }
  return order;
}
