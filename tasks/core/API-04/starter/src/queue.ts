import { randomUUID } from 'node:crypto';
import { QueueStorage } from './storage.ts';
import { natural, QueueError, type Lease, type QueueOptions, type QueueSnapshot, type QueueTask } from './model.ts';
export { QueueError, type Lease, type QueueOptions, type QueueSnapshot } from './model.ts';

/** 持久账本只记录领取和结果；外部执行由 worker.ts 调用。 */
export class DurableQueue {
  readonly #storage: QueueStorage;
  readonly #options: QueueOptions;

  constructor(path: string, options: QueueOptions = {}) {
    const timeout = options.busyTimeoutMs ?? 2000;
    if (!natural(timeout) || timeout > 60000) throw new QueueError('invalid', 'invalid busy timeout');
    this.#storage = new QueueStorage(path, timeout);
    this.#options = options;
  }

  #changed(): void {
    this.#storage.db.exec('UPDATE meta SET revision=revision+1 WHERE id=1');
  }

  submit(key: string, payload: string): string {
    this.#storage.assertOpen();
    if (key.length === 0) throw new QueueError('invalid', 'empty request key');
    let changed = false;
    const id = this.#storage.write(() => {
      const prior = this.#storage.db.prepare('SELECT taskId,payload FROM requests WHERE requestKey=?').get(key);
      if (prior) {
        return prior.taskId as string;
      }
      const taskId = randomUUID();
      this.#storage.db.prepare("INSERT INTO tasks(id,requestKey,payload,state) VALUES (?,?,?,'queued')").run(taskId, key, payload);
      this.#options.onCheckpoint?.('submit-written');
      this.#storage.db.prepare('INSERT INTO requests VALUES (?,?,?)').run(key, taskId, payload);
      this.#changed();
      changed = true;
      return taskId;
    });
    if (changed) this.#options.onCheckpoint?.('committed');
    return id;
  }

  claim(worker: string, now: number, leaseMs: number): Lease | null {
    this.#storage.assertOpen();
    if (worker.length === 0 || !natural(now) || !natural(leaseMs) || leaseMs === 0 || !natural(now + leaseMs)) {
      throw new QueueError('invalid', 'invalid worker, time or lease');
    }
    const lease = this.#storage.write(() => {
      const row = this.#storage.db.prepare("SELECT * FROM tasks WHERE state='queued' OR (state='leased' AND leaseUntil<=?) ORDER BY seq LIMIT 1").get(now);
      if (!row) return null;
      this.#options.onCheckpoint?.('claim-selected');
      const result: Lease = { taskId: row.id as string, worker, generation: 1, expiresAt: now + leaseMs };
      this.#storage.db.prepare("UPDATE tasks SET state='leased',owner=?,generation=?,leaseUntil=? WHERE id=?")
        .run(worker, result.generation, result.expiresAt, result.taskId);
      this.#options.onCheckpoint?.('claim-written');
      this.#changed();
      return result;
    });
    if (lease) this.#options.onCheckpoint?.('committed');
    return lease;
  }

  complete(lease: Lease, result: string, now: number): boolean {
    this.#storage.assertOpen();
    if (!natural(now) || !natural(lease.generation) || lease.generation === 0 || !natural(lease.expiresAt)) {
      throw new QueueError('invalid', 'invalid lease or time');
    }
    let changed = false;
    const accepted = this.#storage.write(() => {
      const row = this.#storage.db.prepare('SELECT * FROM tasks WHERE id=?').get(lease.taskId);
      if (!row || row.owner !== lease.worker) return false;
      if (row.state === 'completed') {
        const previous = this.#storage.db.prepare('SELECT value FROM results WHERE taskId=?').get(lease.taskId);
        if (previous?.value !== result) throw new QueueError('conflict', 'completed result differs');
        return true;
      }
      if (row.state !== 'leased' || now >= Number(row.leaseUntil)) return false;
      this.#storage.db.prepare('INSERT INTO results VALUES (?,?)').run(lease.taskId, result);
      this.#options.onCheckpoint?.('result-written');
      this.#storage.db.prepare("UPDATE tasks SET state='completed' WHERE id=?").run(lease.taskId);
      this.#changed();
      changed = true;
      return true;
    });
    if (changed) this.#options.onCheckpoint?.('committed');
    return accepted;
  }

  snapshot(): QueueSnapshot {
    this.#storage.assertOpen();
    return this.#storage.write(() => ({
      revision: Number(this.#storage.db.prepare('SELECT revision FROM meta WHERE id=1').get()?.revision),
      tasks: this.#storage.db.prepare('SELECT id,requestKey AS key,payload,state,generation,owner,leaseUntil FROM tasks ORDER BY seq').all() as unknown as QueueTask[],
      results: this.#storage.db.prepare('SELECT taskId,value FROM results ORDER BY rowid').all() as unknown as QueueSnapshot['results'],
    }));
  }

  close(): void { this.#storage.close(); }
}
