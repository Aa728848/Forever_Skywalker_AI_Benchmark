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
    const promise = this.#port.load(key).then(value => {
      const stillCurrent = this.version(key) === version && this.#entries.get(key)?.version === version;
      if (!stillCurrent) {
        const current = this.#entries.get(key);
        if (current !== undefined && current.version === version) this.#entries.delete(key);
      }
      return value;
    });
    this.#entries.set(key, { version, promise });
    return promise;
  }
}
