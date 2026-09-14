import { DependencyGraph, type Change, type Document } from './graph.ts';
export type { Change, Document } from './graph.ts';
export interface Diagnostic { readonly id: string; readonly value: string }
export interface Snapshot { readonly generation: number; readonly documents: readonly Document[]; readonly diagnostics: readonly Diagnostic[] }
export interface Prepared { readonly generation: number; readonly affected: readonly string[] }
export type Evaluate = (document: Document, get: (id: string) => Document | undefined) => string | Promise<string>;

export class DependencyWorkspace {
  #state: { graph: DependencyGraph; generation: number; pending: ReadonlySet<string> };
  #published: Snapshot | null = null;
  #publication = 0;
  #candidates = new WeakMap<Prepared, { snapshot: Snapshot; publication: number }>();

  constructor(documents: readonly Document[]) {
    const graph = new DependencyGraph(documents);
    this.#state = { graph, generation: 0, pending: new Set(graph.documents.keys()) };
  }
  get generation(): number { return this.#state.generation; }
  snapshot(): Snapshot | null { return this.#published; }
  apply(changes: readonly Change[]): number {
    if (changes.length) {
      const next = this.#state.graph.update(changes);
      this.#state = { graph: next.graph, generation: this.#state.generation + 1, pending: new Set([...this.#state.pending, ...next.affected]) };
    }
    return this.#state.generation;
  }
  async prepare(evaluate: Evaluate): Promise<Prepared> {
    const captured = this.#state;
    const publication = this.#publication;
    const affected = Object.freeze([...captured.pending].sort());
    const values = new Map(this.#published?.diagnostics.map(row => [row.id, row.value]) ?? []);
    const results = await Promise.all(affected.map(async id => {
      const doc = captured.graph.documents.get(id);
      return [id, doc ? await evaluate(doc, key => captured.graph.documents.get(key)) : undefined] as const;
    }));
    for (const [id, value] of results) {
      if (value === undefined) values.delete(id); else values.set(id, value);
    }
    const snapshot = Object.freeze({
      generation: captured.generation,
      documents: Object.freeze([...captured.graph.documents.keys()].sort().map(id => captured.graph.documents.get(id)!)),
      diagnostics: Object.freeze([...values.keys()].sort().map(id => Object.freeze({ id, value: values.get(id)! }))),
    });
    const ticket = Object.freeze({ generation: captured.generation, affected });
    this.#candidates.set(ticket, { snapshot, publication });
    return ticket;
  }
  commit(ticket: Prepared): boolean {
    const candidate = this.#candidates.get(ticket);
    if (!candidate || candidate.publication !== this.#publication || ticket.generation !== this.#state.generation) return false;
    this.#published = candidate.snapshot;
    this.#publication++;
    this.#state = { ...this.#state, pending: new Set() };
    return true;
  }
}

