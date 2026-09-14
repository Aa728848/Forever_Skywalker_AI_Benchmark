import { parentPort, threadId, workerData } from 'node:worker_threads';
interface Assignment { readonly id: string; readonly payload: number }
// 固定 worker 同时接受单项分发与批次分发；每个输入恰好发布一条真实线程消息。
const assignments: readonly Assignment[] = Array.isArray(workerData) ? workerData : [workerData];
for (const assignment of assignments) {
  const failed = assignment.payload < 0;
  parentPort?.postMessage({ id: assignment.id, threadId, value: failed ? null : assignment.payload * 2, error: failed ? 'payload 不能为负数' : null });
}
