/**
 * 替代实现：用显式 attempt 记录与手动兑现/拒绝表达同一契约。
 * 结构与参考实现不同，用于证明检查未绑定某一种代码写法。
 */
export type KeyedLoaderSource<V> = (key: string) => Promise<V>;

interface Attempt<V> {
  readonly promise: Promise<V>;
  settle(value: V): void;
  fail(error: unknown): void;
  closed: boolean;
}

export class KeyedLoader<V> {
  readonly #source: KeyedLoaderSource<V>;
  readonly #values = new Map<string, V>();
  readonly #attempts = new Map<string, Attempt<V>>();

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
    const open = this.#attempts.get(key);
    if (open !== undefined) return open.promise;

    let resolve!: (value: V) => void;
    let reject!: (error: unknown) => void;
    const attempt: Attempt<V> = {
      promise: new Promise<V>((onValue, onError) => {
        resolve = onValue;
        reject = onError;
      }),
      closed: false,
      settle: (value) => {
        if (attempt.closed) return;
        attempt.closed = true;
        if (this.#attempts.get(key) === attempt) this.#attempts.delete(key);
        this.#values.set(key, value);
        resolve(value);
      },
      fail: (error) => {
        if (attempt.closed) return;
        attempt.closed = true;
        if (this.#attempts.get(key) === attempt) this.#attempts.delete(key);
        reject(error);
      },
    };
    this.#attempts.set(key, attempt);

    let started: Promise<V>;
    try {
      started = Promise.resolve(this.#source(key));
    } catch (error) {
      attempt.fail(error);
      return attempt.promise;
    }
    void started.then((value) => attempt.settle(value), (error: unknown) => attempt.fail(error));
    return attempt.promise;
  }
}
