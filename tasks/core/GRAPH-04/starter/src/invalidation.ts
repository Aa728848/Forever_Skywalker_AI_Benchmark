export interface Node { readonly id: string; readonly deps: readonly string[] }

export class UnknownNodeError extends Error {
  readonly node: string;
  constructor(node: string) {
    super('未知节点：' + node);
    this.name = 'UnknownNodeError';
    this.node = node;
  }
}

function consumersOf(nodes: readonly Node[]): Map<string, string[]> {
  const consumers = new Map<string, string[]>();
  for (const node of nodes) consumers.set(node.id, []);
  for (const node of nodes) {
    for (const dependency of node.deps) {
      const list = consumers.get(dependency);
      if (list === undefined) throw new UnknownNodeError(dependency);
      list.push(node.id);
    }
  }
  return consumers;
}

export class Invalidator {
  readonly #consumers: Map<string, string[]>;

  constructor(nodes: readonly Node[]) {
    this.#consumers = consumersOf(nodes);
  }

  invalidate(changed: readonly string[]): readonly string[] {
    const affected = new Set<string>();
    for (const id of changed) {
      if (!this.#consumers.has(id)) throw new UnknownNodeError(id);
      affected.add(id);
      for (const consumer of this.#consumers.get(id) as string[]) affected.add(consumer);
    }
    return [...affected].sort();
  }
}
