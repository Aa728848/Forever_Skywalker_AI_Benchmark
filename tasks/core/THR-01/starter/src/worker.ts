import { parentPort, threadId, workerData } from 'node:worker_threads';

interface Assignment { readonly id: string; readonly payload: number }

const assignment = workerData as Assignment;
const failed = assignment.payload < 0;
parentPort?.postMessage({
  id: assignment.id,
  threadId,
  value: failed ? null : assignment.payload * 2,
  error: failed ? 'payload 不能为负数' : null,
});
