export interface CachePort {
  load(key: string): Promise<string>;
}

export class StaleWriteError extends Error {
  readonly key: string;
  constructor(key: string) {
    super('拒绝写入已失效的在途结果：' + key);
    this.name = 'StaleWriteError';
    this.key = key;
  }
}

interface Entry {
  readonly version: number;
  readonly promise: Promise<string>;
}

/** 替代实现：用 generation 计数器判定，过期结果显式返回但不入缓存。 */
export class VersionedCache {
  readonly #port: CachePort;
  readonly #entries = new Map<string, { version: number; promise: Promise<string> }>();
  readonly #generation = new Map<string, number>();

  constructor(port: CachePort) {
    this.#port = port;
  }

  version(key: string): number {
    return this.#generation.get(key) ?? 0;
  }

  invalidate(key: string): void {
    const next = this.version(key) + 1;
    this.#generation.set(key, next);
    const current = this.#entries.get(key);
    if (current !== undefined && current.version !== next) this.#entries.delete(key);
  }

  get(key: string): Promise<string> {
    const hit = this.#entries.get(key);
    if (hit !== undefined) return hit.promise;
    const version = this.version(key);
    let loaded: Promise<string>;
    try { loaded = this.#port.load(key); } catch (error) { return Promise.reject(error); }
    const promise = loaded.then(value => {
      const stillCurrent = this.version(key) === version && this.#entries.get(key)?.version === version;
      if (!stillCurrent) {
        const current = this.#entries.get(key);
        if (current !== undefined && current.version === version) this.#entries.delete(key);
      }
      return value;
    }, error => {
      if (this.#entries.get(key)?.promise === promise) this.#entries.delete(key);
      throw error;
    });
    this.#entries.set(key, { version, promise });
    return promise;
  }

  /** 在同一组代际上读取，失效交错只重试尚未形成一致视图的一组。 */
  async getMany(keys: readonly string[]): Promise<readonly string[]> {
    const requested = [...keys];
    for (;;) {
      const versions = requested.map(key => this.version(key));
      const values = await Promise.all(requested.map(key => this.get(key)));
      if (requested.every((key, index) => this.version(key) === versions[index])) return Object.freeze(values);
    }
  }
}
