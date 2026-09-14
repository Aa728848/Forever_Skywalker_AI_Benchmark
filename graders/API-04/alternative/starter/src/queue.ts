import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { natural, QueueError, type Lease, type QueueOptions, type QueueSnapshot } from './model.ts';
export { QueueError, type Lease, type QueueOptions, type QueueSnapshot } from './model.ts';

/** 替代方案：单行持久文档 + 内存纯变换；不使用关系表之间的多次 UPDATE。 */
export class DurableQueue {
  readonly #db: DatabaseSync;
  readonly #options: QueueOptions;
  #closed = false;

  constructor(path: string, options: QueueOptions = {}) {
    const timeout = options.busyTimeoutMs ?? 2000;
    if (!natural(timeout) || timeout > 60000) throw new QueueError('invalid', 'invalid timeout');
    this.#options = options;
    this.#db = new DatabaseSync(path);
    this.#db.exec(`PRAGMA busy_timeout=${timeout}; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS document(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
      INSERT OR IGNORE INTO document VALUES(1,'{"revision":0,"tasks":[],"results":[]}');`);
  }

  #open(): void { if (this.#closed) throw new QueueError('closed', 'queue is closed'); }
  #read(): QueueSnapshot { return JSON.parse(this.#db.prepare('SELECT body FROM document WHERE id=1').get()!.body as string) as QueueSnapshot; }

  #change<T>(apply: (state: QueueSnapshot) => { value: T; changed: boolean }): T {
    this.#open();
    try { this.#db.exec('BEGIN IMMEDIATE'); }
    catch (error) {
      if ((error as { errcode?: number }).errcode === 5) throw new QueueError('busy', 'writer busy');
      throw error;
    }
    let outcome: { value: T; changed: boolean };
    try {
      const state = this.#read();
      outcome = apply(state);
      if (outcome.changed) {
        state.revision += 1;
        this.#db.prepare('UPDATE document SET body=? WHERE id=1').run(JSON.stringify(state));
      }
      this.#db.exec('COMMIT');
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
    if (outcome.changed) this.#options.onCheckpoint?.('committed');
    return outcome.value;
  }

  submit(key: string, payload: string): string {
    this.#open();
    if (key.length === 0) throw new QueueError('invalid', 'empty key');
    return this.#change(state => {
      const old = state.tasks.find(item => item.key === key);
      if (old) {
        if (old.payload !== payload) throw new QueueError('conflict', 'content changed');
        return { value: old.id, changed: false };
      }
      const id = randomUUID();
      state.tasks.push({ id, key, payload, state: 'queued', generation: 0, owner: null, leaseUntil: null });
      this.#options.onCheckpoint?.('submit-written');
      return { value: id, changed: true };
    });
  }

  claim(worker: string, now: number, leaseMs: number): Lease | null {
    this.#open();
    if (worker.length === 0 || !natural(now) || !natural(leaseMs) || leaseMs === 0 || !natural(now + leaseMs)) {
      throw new QueueError('invalid', 'invalid lease');
    }
    return this.#change<Lease | null>(state => {
      const row = state.tasks.find(item => item.state === 'queued' || (item.state === 'leased' && item.leaseUntil! <= now));
      if (!row) return { value: null, changed: false };
      this.#options.onCheckpoint?.('claim-selected');
      row.state = 'leased'; row.owner = worker; row.generation += 1; row.leaseUntil = now + leaseMs;
      this.#options.onCheckpoint?.('claim-written');
      return { value: { taskId: row.id, worker, generation: row.generation, expiresAt: row.leaseUntil }, changed: true };
    });
  }

  complete(lease: Lease, result: string, now: number): boolean {
    this.#open();
    if (!natural(now) || !natural(lease.generation) || lease.generation === 0 || !natural(lease.expiresAt)) throw new QueueError('invalid', 'invalid completion');
    return this.#change(state => {
      const row = state.tasks.find(item => item.id === lease.taskId);
      if (!row || row.owner !== lease.worker || row.generation !== lease.generation || row.leaseUntil !== lease.expiresAt) return { value: false, changed: false };
      if (row.state === 'completed') {
        if (state.results.find(item => item.taskId === row.id)?.value !== result) throw new QueueError('conflict', 'result changed');
        return { value: true, changed: false };
      }
      if (row.state !== 'leased' || now >= row.leaseUntil!) return { value: false, changed: false };
      state.results.push({ taskId: row.id, value: result });
      this.#options.onCheckpoint?.('result-written');
      row.state = 'completed';
      return { value: true, changed: true };
    });
  }

  snapshot(): QueueSnapshot { this.#open(); return this.#read(); }
  close(): void { if (!this.#closed) { this.#db.close(); this.#closed = true; } }
}
