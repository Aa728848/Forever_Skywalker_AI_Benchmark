export class IdempotencyConflictError extends Error { constructor() { super('同一幂等键对应不同请求'); } }
interface Entry<T> { readonly request: string; readonly result: Promise<T> }
export class IdempotentWriter<T> {
  #requests = new Map<string, string>();
  #results = new Map<string, Promise<T>>();
  write(key: string, request: string, commit: (body: string) => Promise<T>): Promise<T> {
    if (this.#requests.has(key)) {
      if (this.#requests.get(key) !== request) return Promise.reject(new IdempotencyConflictError());
      return this.#results.get(key)!;
    }
    this.#requests.set(key, request);
    const pending = Promise.resolve().then(() => commit(request));
    const result = pending.then(value => value, error => { this.#requests.delete(key); this.#results.delete(key); throw error; });
    this.#results.set(key, result);
    return result;
  }
}
