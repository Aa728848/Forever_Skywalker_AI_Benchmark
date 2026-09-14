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

export class JobRunner {
  readonly #store: JobStore;
  readonly #effects: EffectLedger;
  readonly #checkpoint: Checkpoint;

  constructor(store: JobStore, effects: EffectLedger) {
    this.#store = store;
    this.#effects = effects;
    this.#checkpoint = readCheckpoint(store);
  }

  apply(events: readonly JobEvent[]): ApplyOutcome {
    return this.#run(events);
  }

  resume(events: readonly JobEvent[]): ApplyOutcome {
    return this.#run(events);
  }

  state(): JobStateSnapshot {
    return { committed: [...this.#checkpoint.committed], pending: [...this.#checkpoint.pending], lastSeq: this.#checkpoint.lastSeq };
  }

  #run(events: readonly JobEvent[]): ApplyOutcome {
    const applied: string[] = [];
    const skipped: string[] = [];
    for (const event of orderEvents(events)) {
      this.#effects.apply(event.id);
      applyToState(this.#checkpoint, event);
      this.#checkpoint.processed.push(event.id);
      this.#checkpoint.lastSeq = event.seq;
      this.#store.write(checkpointKey, JSON.stringify(this.#checkpoint));
      applied.push(event.id);
    }
    return { applied, skipped };
  }
}

