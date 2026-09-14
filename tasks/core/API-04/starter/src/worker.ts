import { DurableQueue, type Lease } from './queue.ts';

/** execute 可被再次调用；只有账本里的结果受租约保护。 */
export async function runOne(
  queue: DurableQueue,
  worker: string,
  clock: () => number,
  leaseMs: number,
  execute: (payload: string, lease: Lease) => Promise<string>,
): Promise<'idle' | 'completed' | 'superseded'> {
  const lease = queue.claim(worker, clock(), leaseMs);
  if (lease === null) return 'idle';
  const task = queue.snapshot().tasks.find(row => row.id === lease.taskId);
  if (!task) throw new Error('claimed task is missing');
  const result = await execute(task.payload, lease);
  return queue.complete(lease, result, clock()) ? 'completed' : 'superseded';
}
