export interface Timer {
  cancel(): void;
}

export interface Scheduler {
  every(intervalMs: number, run: () => void): Timer;
}

export class Poller {
  readonly #tick: () => void;
  readonly #scheduler: Scheduler;
  readonly #intervalMs: number;
  #timer: Timer | null = null;
  #running = false;

  constructor(tick: () => void, scheduler: Scheduler, intervalMs = 1000) {
    this.#tick = tick;
    this.#scheduler = scheduler;
    this.#intervalMs = intervalMs;
  }

  get running(): boolean {
    return this.#running;
  }

  get activeTimers(): number {
    return this.#timer === null ? 0 : 1;
  }

  start(): void {
    this.#timer = this.#scheduler.every(this.#intervalMs, this.#tick);
    this.#running = true;
  }

  stop(): void {
    this.#running = false;
  }
}
