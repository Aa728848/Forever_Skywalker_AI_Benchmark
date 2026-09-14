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

export class RequestCoordinator {
  readonly #port: RequestPort;
  readonly #inFlight = new Map<string, Entry>();

  constructor(port: RequestPort) {
    this.#port = port;
  }

  get pending(): number {
    return this.#inFlight.size;
  }

  request(key: string, payload: string): Promise<string> {
    const controller = new AbortController();
    let rejectOuter: (error: unknown) => void = () => {};
    const promise = new Promise<string>((resolve, reject) => {
      rejectOuter = reject;
      // 缺陷：不取代同 key 的旧请求，旧请求照常结算。
      this.#port.send(key, payload, controller.signal).then(resolve, reject);
    });
    this.#inFlight.set(key, { controller, reject: rejectOuter, settled: false });
    // 缺陷：结算后不清理 pending，计数只增不减。
    return promise;
  }

  cancelAll(): void {
    // 缺陷：不 abort signal，还用普通 Error 而不是 SupersededError 拒绝。
    for (const entry of [...this.#inFlight.values()]) entry.reject(new Error('已取消'));
    this.#inFlight.clear();
  }
}
