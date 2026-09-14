import test from 'node:test';
import assert from 'node:assert/strict';
import { CancelledError, TimeoutError, runCancelable, type Scheduler } from '../starter/src/cancelable.ts';

function fakeScheduler() {
  const timers: Array<{ delayMs: number; run: () => void; cancelled: boolean }> = [];
  const scheduler: Scheduler = {
    after(delayMs, run) {
      const record = { delayMs, run, cancelled: false };
      timers.push(record);
      return { cancel() { record.cancelled = true; } };
    },
  };
  return {
    scheduler,
    timers,
    live: () => timers.filter(timer => !timer.cancelled),
    fire: () => { for (const timer of timers) if (!timer.cancelled) timer.run(); },
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<string> {
  try { await promise; return 'resolved'; } catch (error) {
    if (error instanceof CancelledError) return 'cancelled';
    if (error instanceof TimeoutError) return 'timeout';
    return 'other:' + String(error);
  }
}

const pending = () => new Promise<never>(() => {});

test('hidden/resolves-with-work-result', async () => {
  const fake = fakeScheduler();
  const task = runCancelable(async () => 42, { scheduler: fake.scheduler });
  assert.equal(await task.promise, 42);
  assert.equal(fake.live().length, 0);
});

test('hidden/cancel-aborts-signal-and-rejects', async () => {
  const fake = fakeScheduler();
  const state: { signal: AbortSignal | null } = { signal: null };
  const task = runCancelable(signal => { state.signal = signal; return pending(); }, { scheduler: fake.scheduler });
  task.cancel();
  assert.equal(state.signal?.aborted, true);
  assert.equal(await rejectionOf(task.promise), 'cancelled');
  task.cancel();
  assert.equal(fake.live().length, 0);
});

test('hidden/timeout-rejects-and-aborts', async () => {
  const fake = fakeScheduler();
  const state: { signal: AbortSignal | null } = { signal: null };
  const task = runCancelable(signal => { state.signal = signal; return pending(); }, { scheduler: fake.scheduler, timeoutMs: 50 });
  assert.equal(fake.timers[0]?.delayMs, 50);
  fake.fire();
  assert.equal(state.signal?.aborted, true);
  assert.equal(await rejectionOf(task.promise), 'timeout');
});

test('hidden/clears-timer-after-settle', async () => {
  const fake = fakeScheduler();
  const task = runCancelable(async () => 'done', { scheduler: fake.scheduler });
  assert.equal(await task.promise, 'done');
  assert.equal(fake.live().length, 0);
  fake.fire();
  assert.equal(await task.promise, 'done');
});

test('hidden/propagates-work-errors', async () => {
  const fake = fakeScheduler();
  const boom = new Error('工作失败');
  const task = runCancelable(() => { throw boom; }, { scheduler: fake.scheduler });
  assert.equal(await rejectionOf(task.promise), 'other:Error: 工作失败');
  assert.equal(fake.live().length, 0);
  const late = runCancelable(async () => 'x', { scheduler: fake.scheduler });
  assert.equal(await late.promise, 'x');
  late.cancel();
  assert.equal(await late.promise, 'x');
});
