export interface Runner {
  run(signal: AbortSignal): Promise<void>;
}

export type Phase = 'idle' | 'starting' | 'running' | 'stopping';

/** 替代实现：用状态机 + 串行队列（每次操作都排在上一次之后）。 */
export class Supervisor {
  readonly #runner: Runner;
  #phase: Phase = 'idle';
  #controller: AbortController | null = null;
  #queue: Promise<void> = Promise.resolve();
  #current: Promise<void> | null = null;
  #starts = 0;

  constructor(runner: Runner) {
    this.#runner = runner;
  }

  get phase(): Phase {
    return this.#phase;
  }

  get startCount(): number {
    return this.#starts;
  }

  #schedule<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.then(() => undefined, () => undefined);
    return next;
  }

  start(): Promise<void> {
    return this.#schedule(async () => {
      if (this.#phase === "running" || this.#phase === "starting") return;
      this.#phase = "starting";
      this.#starts += 1;
      const controller = new AbortController();
      this.#controller = controller;
      this.#current = this.#runner.run(controller.signal).catch(() => {});
      this.#phase = "running";
    });
  }

  stop(): Promise<void> {
    return this.#schedule(async () => {
      if (this.#phase === "idle") return;
      this.#phase = "stopping";
      this.#controller?.abort();
      this.#controller = null;
      await this.#current;
      this.#current = null;
      this.#phase = "idle";
    });
  }
}
