import { UnknownNodeError } from './invalidation.ts';
export interface Document { readonly id: string; readonly deps: readonly string[]; readonly value: string }
export type Change = { readonly kind: 'put'; readonly document: Document } | { readonly kind: 'delete'; readonly id: string };

export class DependencyGraph {
  readonly documents: ReadonlyMap<string, Document>;
  readonly reverse: ReadonlyMap<string, readonly string[]>;
  constructor(documents: readonly Document[]) {
    const records = new Map<string, Document>();
    for (const doc of documents) {
      if (records.has(doc.id)) throw new TypeError('Duplicate document');
      records.set(doc.id, Object.freeze({ id: doc.id, value: doc.value, deps: Object.freeze([...new Set(doc.deps)].sort()) }));
    }
    const reverse = new Map<string, string[]>();
    for (const id of records.keys()) reverse.set(id, []);
    for (const doc of records.values()) for (const id of doc.deps) {
      if (!reverse.has(id)) reverse.set(id, []);
      reverse.get(id)!.push(doc.id);
    }
    this.documents = records; this.reverse = reverse;
  }
  affected(changed: readonly string[]): Set<string> {
    const result = new Set<string>();
    const stack = [...changed];
    while (stack.length) {
      const id = stack.pop()!;
      if (result.has(id)) continue;
      result.add(id);
      for (const consumer of this.reverse.get(id) ?? []) stack.push(consumer);
    }
    return result;
  }
  update(changes: readonly Change[]): { graph: DependencyGraph; affected: Set<string> } {
    const operations = new Map<string, Change>();
    for (const change of changes) {
      const id = change.kind === 'put' ? change.document.id : change.id;
      if (operations.has(id)) throw new TypeError('Duplicate change');
      if (change.kind === 'delete' && !this.documents.has(id)) throw new UnknownNodeError(id);
      operations.set(id, change);
    }
    const records: Document[] = [];
    for (const document of this.documents.values()) if (!operations.has(document.id)) records.push(document);
    for (const change of operations.values()) if (change.kind === 'put') records.push(change.document);
    const graph = new DependencyGraph(records);
    const changed = [...operations.keys()];
    const affected = this.affected(changed);
    for (const id of graph.affected(changed)) affected.add(id);
    return { graph, affected };
  }
}
