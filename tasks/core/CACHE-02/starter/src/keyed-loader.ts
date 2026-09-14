/**
 * 按 key 合并并发加载并缓存成功结果。
 *
 * 调用者只依赖下列公开契约：同键并发只调用一次 source、成功结果被缓存、
 * has/delete/size/clear 只作用于已缓存值。
 */
export type KeyedLoaderSource<V> = (key: string) => Promise<V>;

export class KeyedLoader<V> {
  readonly #source: KeyedLoaderSource<V>;
  readonly #values = new Map<string, V>();
  readonly #inflight = new Map<string, Promise<V>>();

  constructor(source: KeyedLoaderSource<V>) {
    this.#source = source;
  }

  get size(): number {
    return this.#values.size;
  }

  has(key: string): boolean {
    return this.#values.has(key);
  }

  delete(key: string): boolean {
    return this.#values.delete(key);
  }

  clear(): void {
    this.#values.clear();
  }

  load(key: string): Promise<V> {
    if (this.#values.has(key)) return Promise.resolve(this.#values.get(key) as V);
    const running = this.#inflight.get(key);
    if (running !== undefined) return running;
    const attempt = this.#source(key).then(
      (value) => {
        this.#values.set(key, value);
        this.#inflight.delete(key);
        return value;
      },
      (error: unknown) => {
        // 保留在途记录，让后续调用者复用同一次尝试的结果。
        throw error;
      },
    );
    this.#inflight.set(key, attempt);
    return attempt;
  }
}
