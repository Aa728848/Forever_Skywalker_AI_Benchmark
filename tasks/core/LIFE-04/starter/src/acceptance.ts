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

export class AcceptanceRunner {
  readonly #port: ChildPort;
  readonly #reaped: number[] = [];
  #busy = false;

  constructor(port: ChildPort) {
    this.#port = port;
  }

  get busy(): boolean {
    return this.#busy;
  }

  get reaped(): readonly number[] {
    return [...this.#reaped];
  }

  accept(): Promise<AcceptanceResult> {
    // 缺陷：不检查是否已有验收在途，第二次调用会直接启动第二个子进程。
    const child = this.#port.spawn();
    this.#busy = true;
    return new Promise<AcceptanceResult>(resolve => {
      child.onExit((code, signal) => {
        this.#reaped.push(child.pid);
        const fault = classify(code, signal);
        if (fault !== 'exited') child.kill();
        this.#busy = false;
        resolve({ fault, signal });
      });
    });
  }
}
