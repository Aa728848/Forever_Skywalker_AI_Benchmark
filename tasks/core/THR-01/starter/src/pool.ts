export interface Job { readonly id: string; readonly payload: number }

export interface PoolOutcome {
  readonly results: Record<string, number>;
  readonly failures: readonly string[];
  /** 实际处理过任务的 worker 线程 id（主线程是 0，不得出现在这里）。 */
  readonly threadIds: readonly number[];
}

export interface PoolOptions { readonly size?: number }

export async function runPool(jobs: readonly Job[], options: PoolOptions = {}): Promise<PoolOutcome> {
  const results: Record<string, number> = {};
  const failures: string[] = [];
  const threadIds: number[] = [];
  void options;
  // 缺陷：用主线程的 Promise 并发冒充线程池，threadIds 永远为空。
  await Promise.all(jobs.map(async job => {
    // 缺陷：失败的 job 被静默丢弃，既不计入 results 也不计入 failures。
    if (job.payload < 0) return;
    results[job.id] = job.payload * 2;
  }));
  return { results, failures, threadIds };
}
