export interface Job { readonly id: string; readonly payload: number }

export interface PoolOutcome {
  readonly results: Record<string, number>;
  readonly failures: readonly string[];
  /** 实际处理过任务的 worker 线程 id（主线程是 0，不得出现在这里）。 */
  readonly threadIds: readonly number[];
}

export interface PoolOptions { readonly size?: number }

interface WorkerMessage {
  readonly id: string;
  readonly threadId: number;
  readonly value: number | null;
  readonly error: string | null;
}

import { Worker } from 'node:worker_threads';

/** 替代实现：递归补位，每完成一个任务再启动下一个。 */
export async function runPool(jobs: readonly Job[], options: PoolOptions = {}): Promise<PoolOutcome> {
  const results: Record<string, number> = {};
  const failures: string[] = [];
  const threadIds = new Set<number>();
  if (jobs.length === 0) return { results, failures, threadIds: [] };
  const requested = options.size ?? 4;
  if (!Number.isInteger(requested) || requested < 1) throw new RangeError('size 必须是大于等于 1 的整数');
  const pending = jobs.slice();
  const run = (): Promise<void> | null => {
    const job = pending.shift();
    if (job === undefined) return null;
    return new Promise<void>((resolve, reject) => {
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { workerData: { id: job.id, payload: job.payload } });
      worker.once('message', (message: WorkerMessage) => {
        threadIds.add(message.threadId);
        if (message.error === null) results[message.id] = message.value as number;
        else failures.push(message.id);
        void worker.terminate();
        const next = run();
        if (next === null) resolve();
        else next.then(resolve, reject);
      });
      worker.once('error', reject);
    });
  };
  const window: Promise<void>[] = [];
  for (let index = 0; index < Math.min(requested, jobs.length); index += 1) {
    const started = run();
    if (started !== null) window.push(started);
  }
  await Promise.all(window);
  return { results, failures, threadIds: [...threadIds].sort((left, right) => left - right) };
}
