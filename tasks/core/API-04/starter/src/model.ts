export type Checkpoint = 'submit-written' | 'claim-selected' | 'claim-written' | 'result-written' | 'committed';
export interface QueueOptions {
  onCheckpoint?: (phase: Checkpoint) => void;
  busyTimeoutMs?: number;
}
export interface Lease {
  taskId: string;
  worker: string;
  generation: number;
  expiresAt: number;
}
export interface QueueTask {
  id: string;
  key: string;
  payload: string;
  state: 'queued' | 'leased' | 'completed';
  generation: number;
  owner: string | null;
  leaseUntil: number | null;
}
export interface QueueSnapshot {
  revision: number;
  tasks: QueueTask[];
  results: Array<{ taskId: string; value: string }>;
}
export class QueueError extends Error {
  readonly code: 'invalid' | 'conflict' | 'closed' | 'busy';
  constructor(code: QueueError['code'], message: string) {
    super(message);
    this.name = 'QueueError';
    this.code = code;
  }
}
export function natural(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
