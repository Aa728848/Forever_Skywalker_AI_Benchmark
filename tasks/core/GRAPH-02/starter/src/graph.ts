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

export function topologicalOrder(nodes: readonly string[], edges: readonly Edge[]): readonly string[] {
  const unique = [...new Set(nodes)];
  const successors = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const node of unique) {
    successors.set(node, []);
    inDegree.set(node, 0);
  }
  for (const edge of edges) {
    if (!successors.has(edge.from)) throw new UnknownNodeError(edge.from);
    if (!successors.has(edge.to)) throw new UnknownNodeError(edge.to);
    // 缺陷：不去重、不排序，直接按输入顺序累加，重复边会把入度算重。
    (successors.get(edge.from) as string[]).push(edge.to);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }
  // 缺陷：起始层用输入顺序而不是字典序。
  const ready = unique.filter(node => inDegree.get(node) === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    const node = ready.shift() as string;
    order.push(node);
    for (const next of successors.get(node) as string[]) {
      const remaining = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
  }
  if (order.length !== unique.length) throw new CycleError(findCycle(unique, successors));
  return order;
}
