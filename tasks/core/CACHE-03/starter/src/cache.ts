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

export class VersionedCache {
  readonly #port: CachePort;
  readonly #entries = new Map<string, Entry>();
  readonly #versions = new Map<string, number>();

  constructor(port: CachePort) {
    this.#port = port;
  }

  version(key: string): number {
    return this.#versions.get(key) ?? 0;
  }

  invalidate(key: string): void {
    this.#versions.set(key, this.version(key) + 1);
    this.#entries.delete(key);
  }

  get(key: string): Promise<string> {
    const cached = this.#entries.get(key);
    if (cached !== undefined) return cached.promise;
    const version = this.version(key);
    const promise = this.#port.load(key);
    this.#entries.set(key, { version, promise });
    // 缺陷：结算时无条件写回缓存，被失效的旧结果会重新占据缓存。
    promise.then(
      value => { this.#entries.set(key, { version, promise: Promise.resolve(value) }); },
      () => {},
    );
    return promise;
  }

  async getMany(keys: readonly string[]): Promise<readonly string[]> {
    return Object.freeze(await Promise.all(keys.map(key => this.get(key))));
  }
}
