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
/** 结构与参考实现不同：用行数组 + 前缀拼接，版本号每次从存储现读，不缓存在字段里。 */
function rowsOf(text: string | null): [string, string][] {
  if (text === null) return [];
  let input;try { input = JSON.parse(text); } catch (error) { if (error instanceof SyntaxError) return []; throw error; }
  if (input?.schema !== 1 || !Array.isArray(input.entries) || !input.entries.every(row => Array.isArray(row) && row.length === 2 && row.every(item => typeof item === 'string'))) return [];
  return [...new Map<string, string>(input.entries)];
}
function digest(text: string | null): number {
  if (text === null) return 0;
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index);hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash >>> 0;
}
export class PersistentCache {
  readonly #storage: Storage;readonly #prefix: string[];
  #rows: [string, string][] = [];#boot: Promise<void> | undefined;#queue = Promise.resolve();
  /** 与参考实现字段名不同：这里叫 #seen，语义相同——本实例最后确认过的版本。 */
  #seen = 0;
  constructor(storage: Storage, scope: Scope) { this.#storage = storage;this.#prefix = [scope.workspace, scope.model, scope.rules]; }
  #identity(key: string): string { return JSON.stringify([...this.#prefix, key]); }
  #versioned(): VersionedStorage | null {
    const candidate = this.#storage as Partial<VersionedStorage>;
    return typeof candidate.readVersioned === 'function' && typeof candidate.writeAtomicIfUnchanged === 'function' ? candidate as VersionedStorage : null;
  }
  #initialize(): Promise<void> {
    if (!this.#boot) {
      this.#boot = (async () => {
        const versioned = this.#versioned();
        if (versioned === null) this.#rows = rowsOf(await this.#storage.read());
        else { const loaded = await versioned.readVersioned();this.#seen = loaded.epoch;this.#rows = rowsOf(loaded.text); }
      })();
      this.#boot.catch(() => { this.#boot = undefined; });
    }
    return this.#boot;
  }
  #schedule<T>(work: () => Promise<T>): Promise<T> { const result = this.#queue.then(work);this.#queue = result.then(() => { }, () => { });return result; }
  async get(key: string): Promise<string | undefined> { await this.#initialize();await this.#queue;return this.#rows.find(row => row[0] === this.#identity(key))?.[1]; }
  set(key: string, value: string): Promise<void> { return this.setMany([[key, value]]); }
  setMany(entries: readonly (readonly [string, string])[]): Promise<void> {
    const captured = entries.map(entry => [...entry]);
    const names = new Set<string>();
    for (const row of captured) { if (row.length !== 2 || typeof row[0] !== 'string' || typeof row[1] !== 'string' || names.has(row[0])) return Promise.reject(new TypeError('invalid batch'));names.add(row[0]); }
    return this.#schedule(async () => {
      await this.#initialize();
      if (!captured.length) return;
      const updates = captured.map(([key, value]) => [this.#identity(key!), value!] as [string, string]);
      const identifiers = new Set(updates.map(row => row[0]));
      const next = [...this.#rows.filter(row => !identifiers.has(row[0])), ...updates];
      const body = JSON.stringify({ schema: 1, entries: next });
      const versioned = this.#versioned();
      if (versioned === null) { await this.#storage.writeAtomic(body);this.#rows = next;return; }
      try { await versioned.writeAtomicIfUnchanged(body, this.#seen); }
      catch (error) {
        if (error instanceof StaleWriteError) { const current = await versioned.readVersioned();this.#seen = current.epoch;this.#rows = rowsOf(current.text); }
        throw error;
      }
      this.#seen = (await versioned.readVersioned()).epoch;
      this.#rows = next;
    });
  }
  refresh(): Promise<void> { return this.#schedule(async () => {
    await this.#initialize();
    const versioned = this.#versioned();
    if (versioned === null) this.#rows = rowsOf(await this.#storage.read());
    else { const loaded = await versioned.readVersioned();this.#seen = loaded.epoch;this.#rows = rowsOf(loaded.text); }
  }); }
  snapshot(keys: readonly string[]): Promise<readonly { readonly key: string;readonly value: string | undefined }[]> {
    const captured = Array.from(keys);
    return this.#schedule(async () => { await this.#initialize();const output = captured.map(key => Object.freeze({ key, value: this.#rows.find(row => row[0] === this.#identity(key))?.[1] }));return Object.freeze(output); });
  }
  async recover(journal: readonly (readonly [string, string])[]): Promise<void> {
    await this.#initialize();
    const restored: [string, string][] = journal.map(([key, value]) => [this.#identity(key), value]);
    const identifiers = new Set(restored.map(row => row[0]));
    this.#rows = [...this.#rows.filter(row => !identifiers.has(row[0])), ...restored];
  }
}
