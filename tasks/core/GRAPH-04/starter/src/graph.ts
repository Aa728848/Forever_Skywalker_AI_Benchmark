import { UnknownNodeError } from './invalidation.ts';

export interface Document { readonly id: string; readonly deps: readonly string[]; readonly value: string }
export type Change = { readonly kind: 'put'; readonly document: Document } | { readonly kind: 'delete'; readonly id: string };

export function copyDocument(document: Document): Document {
  return Object.freeze({ id: document.id, deps: Object.freeze([...new Set(document.deps)].sort()), value: document.value });
}

export class DependencyGraph {
  readonly documents: ReadonlyMap<string, Document>;
  readonly reverse: ReadonlyMap<string, ReadonlySet<string>>;

  constructor(documents: readonly Document[], reverse?: ReadonlyMap<string, ReadonlySet<string>>) {
    const records = new Map<string, Document>();
    for (const document of documents) {
      if (records.has(document.id)) throw new TypeError('Duplicate document: ' + document.id);
      records.set(document.id, copyDocument(document));
    }
    this.documents = records;
    if (reverse) this.reverse = reverse;
    else {
      const index = new Map<string, Set<string>>();
      for (const id of records.keys()) index.set(id, new Set());
      for (const document of records.values()) for (const id of document.deps) {
        if (!index.has(id)) index.set(id, new Set());
        index.get(id)!.add(document.id);
      }
      this.reverse = index;
    }
  }

  affected(changed: readonly string[]): Set<string> {
    const affected = new Set(changed);
    const queue = [...changed];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      for (const consumer of this.reverse.get(queue[cursor]!) ?? []) {
        if (!affected.has(consumer)) { affected.add(consumer); queue.push(consumer); }
      }
    }
    return affected;
  }

  update(changes: readonly Change[]): { graph: DependencyGraph; affected: Set<string> } {
    const changed: string[] = [];
    const records = new Map(this.documents);
    const seen = new Set<string>();
    for (const change of changes) {
      const id = change.kind === 'put' ? change.document.id : change.id;
      if (seen.has(id)) throw new TypeError('Duplicate change: ' + id);
      seen.add(id); changed.push(id);
      if (change.kind === 'put') records.set(id, copyDocument(change.document));
      else {
        if (!this.documents.has(id)) throw new UnknownNodeError(id);
        records.delete(id);
      }
    }
    const reverse = new Map(this.reverse);
    const touched = new Set<string>();
    const mutable = (id: string): Set<string> => {
      if (!touched.has(id)) { reverse.set(id, new Set(reverse.get(id))); touched.add(id); }
      return reverse.get(id) as Set<string>;
    };
    for (const id of changed) {
      for (const dependency of this.documents.get(id)?.deps ?? []) mutable(dependency);
      if (records.has(id)) mutable(id);
    }
    for (const id of changed) for (const dependency of records.get(id)?.deps ?? []) mutable(dependency).add(id);
    for (const id of touched) if (!records.has(id) && reverse.get(id)?.size === 0) reverse.delete(id);
    const graph = new DependencyGraph([...records.values()], reverse);
    const affected = new Set([...this.affected(changed), ...graph.affected(changed)]);
    return { graph, affected };
  }
}

