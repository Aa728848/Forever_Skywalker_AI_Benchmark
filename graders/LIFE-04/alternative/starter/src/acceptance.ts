export interface ChildHandle {
  readonly pid: number;
  kill(): void;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
}

export interface ChildPort {
  spawn(): ChildHandle;
}

export type Fault = 'exited' | 'crashed' | 'killed';

export interface AcceptanceResult {
  readonly fault: Fault;
  readonly signal: string | null;
}

export class BusyError extends Error {
  constructor() {
    super('已有验收在进行中，拒绝重入');
    this.name = 'BusyError';
  }
}

export function classify(code: number | null, signal: string | null): Fault {
  if (signal !== null) return 'killed';
  if (code === 0) return 'exited';
  return 'crashed';
}

/** 替代实现：用当前句柄而非布尔标记表示占用状态。 */
export class AcceptanceRunner {
  readonly #port: ChildPort;
  readonly #reaped: number[] = [];
  #current: ChildHandle | null = null;

  constructor(port: ChildPort) {
    this.#port = port;
  }

  get busy(): boolean {
    return this.#current !== null;
  }

  get reaped(): readonly number[] {
    return [...this.#reaped];
  }

  accept(): Promise<AcceptanceResult> {
    if (this.#current !== null) return Promise.reject(new BusyError());
    const child = this.#port.spawn();
    this.#current = child;
    return new Promise<AcceptanceResult>(resolve => {
      child.onExit((code, signal) => {
        this.#reaped.push(child.pid);
        const fault = classify(code, signal);
        if (fault !== 'exited') child.kill();
        this.#current = null;
        resolve({ fault, signal });
      });
    });
  }
}
