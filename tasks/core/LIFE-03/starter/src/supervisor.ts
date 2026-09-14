export interface Runner {
  run(signal: AbortSignal): Promise<void>;
}

export type Phase = 'idle' | 'starting' | 'running' | 'stopping';

export class Supervisor {
  readonly #runner: Runner;
  #phase: Phase = 'idle';
  #controller = new AbortController();
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

  async start(): Promise<void> {
    if (this.#phase === 'running' || this.#phase === 'starting') return;
    // 缺陷：停止尚未完成时直接启动，并且复用已经被 abort 的 controller。
    this.#phase = 'starting';
    this.#starts += 1;
    const done = this.#runner.run(this.#controller.signal).catch(() => {});
    this.#current = done;
    this.#phase = 'running';
  }

  async stop(): Promise<void> {
    if (this.#phase === 'idle') return;
    this.#phase = 'stopping';
    this.#controller.abort();
    await this.#current;
    this.#current = null;
    this.#phase = 'idle';
  }
}
