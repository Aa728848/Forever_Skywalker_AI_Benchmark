import { DependencyGraph, type Change, type Document } from './graph.ts';
export type { Change, Document } from './graph.ts';

export interface Diagnostic { readonly id: string; readonly value: string }
export interface Snapshot {
  readonly generation: number;
  readonly documents: readonly Document[];
  readonly diagnostics: readonly Diagnostic[];
}
export interface Prepared { readonly generation: number; readonly affected: readonly string[] }
export type Evaluate = (document: Document, get: (id: string) => Document | undefined) => string | Promise<string>;

function immutableSnapshot(generation: number, graph: DependencyGraph, values: ReadonlyMap<string, string>): Snapshot {
  return Object.freeze({
    generation,
    documents: Object.freeze([...graph.documents.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    diagnostics: Object.freeze([...values].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, value]) => Object.freeze({ id, value }))),
  });
}

export class DependencyWorkspace {
  #graph: DependencyGraph;
  #generation = 0;
  #pending: Set<string>;
  #published: Snapshot | null = null;
  #publication = 0;
  #tickets = new WeakMap<Prepared, { snapshot: Snapshot; publication: number }>();

  constructor(documents: readonly Document[]) {
    this.#graph = new DependencyGraph(documents);
    this.#pending = new Set(this.#graph.documents.keys());
  }

  get generation(): number { return this.#generation; }

  apply(changes: readonly Change[]): number {
    if (changes.length === 0) return this.#generation;
    const next = this.#graph.update(changes);
    this.#graph = next.graph;
    this.#pending = next.affected;
    this.#generation++;
    return this.#generation;
  }

  snapshot(): Snapshot | null { return this.#published; }

  async prepare(evaluate: Evaluate): Promise<Prepared> {
    const graph = this.#graph;
    const generation = this.#generation;
    const affected = [...this.#pending].sort();
    const previous = this.#published;
    const publication = this.#publication;
    const values = new Map(previous?.diagnostics.map(item => [item.id, item.value]) ?? []);
    for (const id of affected) {
      const document = graph.documents.get(id);
      if (document) values.set(id, await evaluate(document, key => graph.documents.get(key)));
      else values.delete(id);
    }
    const ticket = Object.freeze({ generation, affected: Object.freeze(affected) });
    this.#tickets.set(ticket, { snapshot: immutableSnapshot(generation, graph, values), publication });
    return ticket;
  }

  commit(ticket: Prepared): boolean {
    const candidate = this.#tickets.get(ticket);
    if (!candidate || candidate.publication !== this.#publication) return false;
    this.#published = candidate.snapshot;
    this.#publication++;
    this.#pending = new Set();
    this.#tickets = new WeakMap();
    return true;
  }
}
