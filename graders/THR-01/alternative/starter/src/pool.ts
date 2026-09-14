export interface Job { readonly id: string; readonly payload: number }

export interface PoolOutcome {
  readonly results: Record<string, number>;
  readonly failures: readonly string[];
  /** 实际处理过任务的 worker 线程 id（主线程是 0，不得出现在这里）。 */
  readonly threadIds: readonly number[];
}

export interface PoolOptions { readonly size?: number }

import { Worker } from 'node:worker_threads';
interface WorkerMessage { id: string; threadId: number; value: number | null; error: string | null }
export async function runPool(jobs: readonly Job[], options: PoolOptions = {}): Promise<PoolOutcome> {
  const size = options.size ?? 4;
  if (!Number.isInteger(size) || size < 1) throw new RangeError('size 必须是正整数');
  const width = Math.min(size, jobs.length);
  const outcomes = await Promise.all(Array.from({length: width}, (_, slot) => new Promise<WorkerMessage[]>((resolve, reject) => {
    const from = Math.floor(jobs.length * slot / width);
    const to = Math.floor(jobs.length * (slot + 1) / width);
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { workerData: jobs.slice(from, to) });
    const messages: WorkerMessage[] = [];
    worker.on('message', message => messages.push(message));
    worker.once('error', reject);
    worker.once('exit', code => code === 0 ? resolve(messages) : reject(new Error('worker exit ' + code)));
  })));
  const messages = outcomes.flat();
  return { results: Object.fromEntries(messages.filter(x => x.error === null).map(x => [x.id, x.value as number])), failures: messages.filter(x => x.error !== null).map(x => x.id), threadIds: [...new Set(messages.map(x => x.threadId))].sort((a,b)=>a-b) };
}
