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

interface Record2<V> { readonly value: V; readonly expiresAt: number | null; touched: number }

/** 替代实现：显式维护 touched 递增序号，逐出时线性选出最小者。 */
export class TtlCache<V> {
  readonly #capacity: number;
  readonly #defaultTtlMs: number | null;
  readonly #now: () => number;
  readonly #records = new Map<string, Record2<V>>();
  #clock = 0;

  constructor(capacity: number, options: CacheOptions = {}) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('容量必须是大于等于 1 的整数');
    const ttl = options.ttlMs ?? null;
    if (ttl !== null && (!Number.isFinite(ttl) || ttl < 0)) throw new RangeError('ttlMs 必须是非负有限数');
    this.#capacity = capacity;
    this.#defaultTtlMs = ttl;
    this.#now = options.now ?? (() => Date.now());
  }

  #live(key: string): Record2<V> | null {
    const record = this.#records.get(key);
    if (record === undefined) return null;
    if (record.expiresAt !== null && this.#now() >= record.expiresAt) {
      this.#records.delete(key);
      return null;
    }
    return record;
  }

  #liveKeys(): string[] {
    const keys: string[] = [];
    for (const key of [...this.#records.keys()]) if (this.#live(key) !== null) keys.push(key);
    return keys;
  }

  get size(): number {
    return this.#liveKeys().length;
  }

  has(key: string): boolean {
    return this.#live(key) !== null;
  }

  get(key: string): V | undefined {
    const record = this.#live(key);
    if (record === null) return undefined;
    this.#clock += 1;
    record.touched = this.#clock;
    return record.value;
  }

  set(key: string, value: V, options: EntryOptions = {}): void {
    const ttl = options.ttlMs === undefined ? this.#defaultTtlMs : options.ttlMs;
    if (ttl !== null && (!Number.isFinite(ttl) || ttl < 0)) throw new RangeError('ttlMs 必须是非负有限数');
    this.#clock += 1;
    this.#records.set(key, { value, expiresAt: ttl === null ? null : this.#now() + ttl, touched: this.#clock });
    const keys = this.#liveKeys();
    while (keys.length > this.#capacity) {
      let victim: string | null = null;
      let smallest = Number.POSITIVE_INFINITY;
      for (const candidate of keys) {
        const record = this.#records.get(candidate);
        if (record !== undefined && record.touched < smallest) {
          smallest = record.touched;
          victim = candidate;
        }
      }
      if (victim === null) break;
      this.#records.delete(victim);
      keys.splice(keys.indexOf(victim), 1);
    }
  }

  delete(key: string): boolean {
    return this.#records.delete(key);
  }

  clear(): void {
    this.#records.clear();
  }
}

