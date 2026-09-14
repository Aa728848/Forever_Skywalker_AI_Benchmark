export interface CacheOptions {
  /** 默认 TTL（毫秒）；缺省表示不过期。 */
  readonly ttlMs?: number;
  /** 可注入时钟，便于测试过期边界。 */
  readonly now?: () => number;
}

export interface EntryOptions {
  /** 该条目的 TTL（毫秒），覆盖默认值。 */
  readonly ttlMs?: number;
}

interface Entry<V> { value: V; expiresAt: number | null }

export class TtlCache<V> {
  readonly #capacity: number;
  readonly #defaultTtlMs: number | null;
  readonly #now: () => number;
  readonly #entries = new Map<string, Entry<V>>();

  constructor(capacity: number, options: CacheOptions = {}) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('容量必须是大于等于 1 的整数');
    const ttl = options.ttlMs ?? null;
    if (ttl !== null && (!Number.isFinite(ttl) || ttl < 0)) throw new RangeError('ttlMs 必须是非负有限数');
    this.#capacity = capacity;
    this.#defaultTtlMs = ttl;
    this.#now = options.now ?? (() => Date.now());
  }

  get size(): number {
    return this.#entries.size;
  }

  #expired(entry: Entry<V>): boolean {
    return entry.expiresAt !== null && this.#now() > entry.expiresAt;
  }

  has(key: string): boolean {
    const entry = this.#entries.get(key);
    if (entry === undefined) return false;
    if (this.#expired(entry)) {
      this.#entries.delete(key);
      return false;
    }
    return true;
  }

  get(key: string): V | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (this.#expired(entry)) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V, options: EntryOptions = {}): void {
    // 缺陷：用逻辑或处理可选值，0 会被当成“未提供”而退回默认 TTL。
    const provided = options.ttlMs;
    const ttl = provided === undefined || provided === 0 ? this.#defaultTtlMs : provided;
    if (ttl !== null && (!Number.isFinite(ttl) || ttl < 0)) throw new RangeError('ttlMs 必须是非负有限数');
    const effective = provided === undefined ? ttl : provided;
    this.#entries.set(key, { value, expiresAt: effective === null ? null : this.#now() + effective });
    while (this.#entries.size > this.#capacity) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#entries.delete(oldest.value);
    }
  }

  delete(key: string): boolean {
    return this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }
}

