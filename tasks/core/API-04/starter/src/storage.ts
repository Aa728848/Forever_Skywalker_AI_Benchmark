import { DatabaseSync } from 'node:sqlite';
import { QueueError } from './model.ts';

/** 一个文件可由多个进程打开；调用方负责把一个业务动作交给 write。 */
export class QueueStorage {
  readonly db: DatabaseSync;
  #closed = false;

  constructor(path: string, busyTimeoutMs: number) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS tasks (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        requestKey TEXT NOT NULL UNIQUE, payload TEXT NOT NULL,
        state TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
        owner TEXT, leaseUntil INTEGER);
      CREATE TABLE IF NOT EXISTS requests (requestKey TEXT PRIMARY KEY, taskId TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS results (taskId TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO meta VALUES (1,0);`);
  }

  assertOpen(): void {
    if (this.#closed) throw new QueueError('closed', 'queue is closed');
  }

  write<T>(operation: () => T): T {
    this.assertOpen();
    return operation();
  }

  close(): void {
    if (this.#closed) return;
    this.db.close();
    this.#closed = true;
  }
}
