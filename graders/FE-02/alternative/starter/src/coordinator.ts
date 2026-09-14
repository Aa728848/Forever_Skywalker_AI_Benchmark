export class SupersededError extends Error {
  readonly key: string;
  constructor(key: string) {
    super('请求已被更新的同 key 请求取代：' + key);
    this.name = 'SupersededError';
    this.key = key;
  }
}

export interface RequestPort {
  send(key: string, payload: string, signal: AbortSignal): Promise<string>;
}

interface Entry {
  readonly controller: AbortController;
  readonly reject: (error: unknown) => void;
  settled: boolean;
}

/** 替代实现：原子状态打包进 entry，用 generation 判定最新请求。 */
export class RequestCoordinator {
  readonly #port: RequestPort;
  readonly #inFlight = new Map<string, Entry & { generation: number }>();
  #generation = 0;

  constructor(port: RequestPort) {
    this.#port = port;
  }

  get pending(): number {
    return this.#inFlight.size;
  }

  request(key: string, payload: string): Promise<string> {
    this.#generation += 1;
    const generation = this.#generation;
    const existing = this.#inFlight.get(key);
    if (existing !== undefined) {
      existing.controller.abort();
      existing.settled = true;
      existing.reject(new SupersededError(key));
      this.#inFlight.delete(key);
    }
    const controller = new AbortController();
    let resolveOuter: (value: string) => void = () => {};
    let rejectOuter: (error: unknown) => void = () => {};
    const promise = new Promise<string>((resolve, reject) => {
      resolveOuter = resolve;
      rejectOuter = reject;
    });
    const entry = { controller, reject: rejectOuter, settled: false, generation };
    this.#inFlight.set(key, entry);
    const done = (): boolean => {
      if (entry.settled) return false;
      entry.settled = true;
      const current = this.#inFlight.get(key);
      if (current !== undefined && current.generation === generation) this.#inFlight.delete(key);
      return true;
    };
    this.#port.send(key, payload, controller.signal).then(
      value => { if (done()) resolveOuter(value); },
      error => { if (done()) rejectOuter(error); },
    );
    return promise;
  }

  cancelAll(): void {
    const entries = [...this.#inFlight.entries()];
    this.#inFlight.clear();
    for (const [key, entry] of entries) {
      entry.controller.abort();
      if (!entry.settled) {
        entry.settled = true;
        entry.reject(new SupersededError(key));
      }
    }
  }
}
