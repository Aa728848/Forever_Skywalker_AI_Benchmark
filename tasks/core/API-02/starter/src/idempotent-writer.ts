export class IdempotencyConflictError extends Error { constructor() { super('同一幂等键对应不同请求'); } }
export class IdempotentWriter<T> {
  #completed = new Map<string, { request: string; result: T }>();
  write(key: string, request: string, commit: (body: string) => Promise<T>): Promise<T> {
    const known = this.#completed.get(key);
    // 缺陷：忽略请求冲突，而且在首次完成前没有保留在途请求。
    if (known !== undefined) return Promise.resolve(known.result);
    return Promise.resolve().then(() => commit(request)).then(result => { this.#completed.set(key, {request, result}); return result; });
  }
}
