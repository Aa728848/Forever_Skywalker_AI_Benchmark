export interface Storage { read(): Promise<string | null>; writeAtomic(text: string): Promise<void> }
export interface Scope { readonly workspace: string; readonly model: string; readonly rules: string }
export interface Snapshot { readonly text: string | null; readonly epoch: number }
export interface VersionedStorage extends Storage {
  readVersioned(): Promise<Snapshot>;
  writeAtomicIfUnchanged(text: string, epoch: number): Promise<void>;
}
export class StaleWriteError extends Error {
  readonly expected: number;
  constructor(expected: number) { super('stale epoch'); this.name = 'StaleWriteError'; this.expected = expected; }
}
export class PersistentCache {
  readonly #storage: Storage; readonly #scope: Scope;
  #entries = new Map<string, string>(); #loading: Promise<void> | undefined; #tail = Promise.resolve();
  constructor(storage: Storage, scope: Scope) { this.#storage = storage; this.#scope = { ...scope }; }
  #key(key: string): string { return JSON.stringify([this.#scope.workspace, key]); }
  #ready(): Promise<void> {
    // 缺陷：每个并发请求都重新加载文件，较晚的冷启动还会覆盖已确认数据。
    this.#loading = this.#storage.read().then(text => {
      if (text === null) return;
      try { const parsed = JSON.parse(text); if (parsed?.schema !== 1 || !Array.isArray(parsed.entries) || !parsed.entries.every((row: unknown) => Array.isArray(row) && row.length === 2 && row.every(x => typeof x === 'string'))) throw new SyntaxError('corrupt cache'); this.#entries = new Map(parsed.entries); }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; this.#entries = new Map(); }
    }).catch(error => { this.#loading = undefined; throw error; });
    return this.#loading;
  }
  async get(key: string): Promise<string | undefined> { await this.#ready(); await this.#tail; return this.#entries.get(this.#key(key)); }
  set(key: string, value: string): Promise<void> {
    const operation = this.#tail.then(async () => { await this.#ready(); const next = new Map(this.#entries); next.set(this.#key(key), value); this.#entries = next; await this.#storage.writeAtomic(JSON.stringify({ schema: 1, entries: [...next] })); });
    this.#tail = operation.catch(() => { });
    return operation;
  }
  async setMany(entries: readonly (readonly [string, string])[]): Promise<void> { for (const [key, value] of entries) await this.set(key, value); }
  async refresh(): Promise<void> { const text = await this.#storage.read(); this.#entries = text === null ? new Map() : new Map(JSON.parse(text).entries); }
  async snapshot(keys: readonly string[]): Promise<readonly { readonly key: string; readonly value: string | undefined }[]> { return Object.freeze(await Promise.all(keys.map(async key => Object.freeze({ key, value: await this.get(key) })))); }
  /** 缺陷：恢复日志只写内存，不落盘也不校验 epoch。 */
  async recover(journal: readonly (readonly [string, string])[]): Promise<void> { await this.#ready(); for (const [key, value] of journal) this.#entries.set(this.#key(key), value); }
  /** 缺陷：二级索引与条目分别维护，崩溃在两者之间会永久不一致。 */
  index(): Map<string, string[]> { const derived = new Map<string, string[]>(); for (const [key, value] of this.#entries) { const bucket = derived.get(value) ?? []; bucket.push(key); derived.set(value, bucket); } return derived; }
  keysFor(value: string): string[] { return [...(this.index().get(value) ?? [])].sort(); }
}
