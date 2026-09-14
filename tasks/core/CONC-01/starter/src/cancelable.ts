export interface TimerHandle {
  cancel(): void;
}

export interface Scheduler {
  after(delayMs: number, run: () => void): TimerHandle;
}

export interface CancelableTask<T> {
  readonly promise: Promise<T>;
  cancel(): void;
}

export class CancelledError extends Error {
  constructor() {
    super('任务已被取消');
    this.name = 'CancelledError';
  }
}

export class TimeoutError extends Error {
  constructor() {
    super('任务超时');
    this.name = 'TimeoutError';
  }
}

export function runCancelable<T>(
  work: (signal: AbortSignal) => Promise<T>,
  options: { scheduler: Scheduler; timeoutMs?: number },
): CancelableTask<T> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 30000;
  let settled = false;
  let resolveTask: (value: T) => void = () => {};
  let rejectTask: (error: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    resolveTask = resolve;
    rejectTask = reject;
  });
  // 缺陷：超时只结算 Promise，既不 abort signal，也不取消定时器。
  options.scheduler.after(timeoutMs, () => {
    if (settled) return;
    settled = true;
    rejectTask(new TimeoutError());
  });
  const started = (() => {
    try {
      return Promise.resolve(work(controller.signal));
    } catch (error) {
      return Promise.reject(error);
    }
  })();
  started.then(
    value => {
      // 缺陷：成功结算后没有取消定时器。
      if (settled) return;
      settled = true;
      resolveTask(value);
    },
    error => {
      if (settled) return;
      settled = true;
      rejectTask(error);
    },
  );
  return {
    promise,
    cancel(): void {
      // 缺陷：取消只结算 Promise，不 abort signal，也不取消定时器。
      if (settled) return;
      settled = true;
      rejectTask(new CancelledError());
    },
  };
}
