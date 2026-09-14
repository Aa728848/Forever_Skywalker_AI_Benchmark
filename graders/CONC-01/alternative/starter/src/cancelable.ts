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

/** 替代实现：显式 pending/done 状态机。 */
export function runCancelable<T>(
  work: (signal: AbortSignal) => Promise<T>,
  options: { scheduler: Scheduler; timeoutMs?: number },
): CancelableTask<T> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 30000;
  let state: 'pending' | 'done' = 'pending';
  let resolveOuter: (value: T) => void = () => {};
  let rejectOuter: (error: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    resolveOuter = resolve;
    rejectOuter = reject;
  });
  const timer = options.scheduler.after(timeoutMs, () => {
    if (state !== 'pending') return;
    state = 'done';
    controller.abort();
    rejectOuter(new TimeoutError());
  });
  const finish = (error: unknown, value?: T): void => {
    if (state !== 'pending') return;
    state = 'done';
    timer.cancel();
    if (error === null) resolveOuter(value as T);
    else rejectOuter(error);
  };
  try {
    work(controller.signal).then(value => finish(null, value), error => finish(error));
  } catch (error) {
    finish(error);
  }
  return {
    promise,
    cancel(): void {
      controller.abort();
      finish(new CancelledError());
    },
  };
}
