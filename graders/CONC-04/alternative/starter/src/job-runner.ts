export interface JobEvent {
  readonly id: string;
  readonly seq: number;
  readonly kind: 'add' | 'commit' | 'cancel';
  readonly payload?: string;
}

export interface JobStore {
  read(key: string): string | null;
  write(key: string, value: string): void;
}

export interface EffectLedger {
  has(effectId: string): boolean;
  apply(effectId: string): void;
}

export interface ApplyOutcome {
  readonly applied: string[];
  readonly skipped: string[];
}

export interface JobStateSnapshot {
  readonly committed: string[];
  readonly pending: string[];
  readonly lastSeq: number;
}

/** 检查点在存储里的固定键。 */
export const checkpointKey = 'job-runner/checkpoint';

interface Checkpoint {
  committed: string[];
  pending: string[];
  lastSeq: number;
  processed: string[];
  effects: string[];
}

function emptyCheckpoint(): Checkpoint {
  return { committed: [], pending: [], lastSeq: 0, processed: [], effects: [] };
}

function cloneCheckpoint(source: Checkpoint): Checkpoint {
  return {
    committed: [...source.committed],
    pending: [...source.pending],
    lastSeq: source.lastSeq,
    processed: [...source.processed],
    effects: [...source.effects],
  };
}

function readCheckpoint(store: JobStore): Checkpoint {
  const raw = store.read(checkpointKey);
  if (raw === null) return emptyCheckpoint();
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) return emptyCheckpoint();
  const value = parsed as Partial<Checkpoint>;
  const list = (input: unknown): string[] => (Array.isArray(input) ? input.filter(item => typeof item === 'string') as string[] : []);
  return {
    committed: list(value.committed),
    pending: list(value.pending),
    lastSeq: typeof value.lastSeq === 'number' ? value.lastSeq : 0,
    processed: list(value.processed),
    effects: list(value.effects),
  };
}

function applyToState(state: Checkpoint, event: JobEvent): void {
  const payload = event.payload;
  if (payload === undefined || payload === '') return;
  if (event.kind === 'add') {
    if (!state.pending.includes(payload)) state.pending.push(payload);
    return;
  }
  if (event.kind === 'commit') {
    state.pending = state.pending.filter(item => item !== payload);
    if (!state.committed.includes(payload)) state.committed.push(payload);
    return;
  }
  state.pending = state.pending.filter(item => item !== payload);
}

function orderEvents(events: readonly JobEvent[]): JobEvent[] {
  return [...events].sort((left, right) => {
    if (left.seq !== right.seq) return left.seq - right.seq;
    if (left.id === right.id) return 0;
    return left.id < right.id ? -1 : 1;
  });
}

/** 替代实现：检查点用独立字段记录 pendingEffect，事件处理与效果结算分成两个阶段。 */
interface SnapshotState {
  committed: string[];
  pending: string[];
  lastSeq: number;
  seen: string[];
  unsettled: string | null;
}

function load(store: JobStore): SnapshotState {
  const raw = store.read(checkpointKey);
  if (raw === null) return { committed: [], pending: [], lastSeq: 0, seen: [], unsettled: null };
  const value = JSON.parse(raw) as Partial<SnapshotState>;
  const list = (input: unknown): string[] => (Array.isArray(input) ? (input as unknown[]).filter(entry => typeof entry === 'string') as string[] : []);
  return {
    committed: list(value.committed),
    pending: list(value.pending),
    lastSeq: typeof value.lastSeq === 'number' ? value.lastSeq : 0,
    seen: list(value.seen),
    unsettled: typeof value.unsettled === 'string' ? value.unsettled : null,
  };
}

export class JobRunner {
  readonly #store: JobStore;
  readonly #effects: EffectLedger;
  #state: SnapshotState;

  constructor(store: JobStore, effects: EffectLedger) {
    this.#store = store;
    this.#effects = effects;
    this.#state = load(store);
  }

  apply(events: readonly JobEvent[]): ApplyOutcome {
    this.#settle();
    const applied: string[] = [];
    const skipped: string[] = [];
    for (const event of orderEvents(events)) {
      const isRepeat = this.#state.seen.includes(event.id) || event.seq <= this.#state.lastSeq;
      if (isRepeat) { skipped.push(event.id); continue; }
      const draft: SnapshotState = {
        committed: [...this.#state.committed],
        pending: [...this.#state.pending],
        lastSeq: event.seq,
        seen: [...this.#state.seen, event.id],
        unsettled: event.id,
      };
      const mutable = { committed: draft.committed, pending: draft.pending };
      applyToState(mutable, event);
      draft.committed = mutable.committed;
      draft.pending = mutable.pending;
      this.#write(draft);
      this.#settle();
      applied.push(event.id);
    }
    return { applied, skipped };
  }

  resume(events: readonly JobEvent[]): ApplyOutcome {
    return this.apply(events);
  }

  state(): JobStateSnapshot {
    return { committed: [...this.#state.committed], pending: [...this.#state.pending], lastSeq: this.#state.lastSeq };
  }

  #settle(): void {
    const effectId = this.#state.unsettled;
    if (effectId === null) return;
    if (!this.#effects.has(effectId)) this.#effects.apply(effectId);
    this.#write({ ...this.#state, unsettled: null });
  }

  #write(next: SnapshotState): void {
    this.#store.write(checkpointKey, JSON.stringify(next));
    this.#state = next;
  }
}

