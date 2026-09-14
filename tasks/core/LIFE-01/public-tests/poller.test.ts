import test from 'node:test';
import assert from 'node:assert/strict';
import { Poller, type Scheduler, type Timer } from '../starter/src/poller.ts';

/** 可控调度器：手动触发与统计，不依赖真实计时。 */
function fakeScheduler() {
  const timers: Array<{ intervalMs: number; run: () => void; cancelled: boolean }> = [];
  const scheduler: Scheduler = {
    every(intervalMs, run) {
      const record = { intervalMs, run, cancelled: false };
      timers.push(record);
      const timer: Timer = { cancel() { record.cancelled = true; } };
      return timer;
    },
  };
  return {
    scheduler,
    timers,
    live: () => timers.filter(timer => !timer.cancelled),
    fireAll: () => { for (const timer of timers) if (!timer.cancelled) timer.run(); },
  };
}

test('public/start-schedules-one-timer', () => {
  const fake = fakeScheduler();
  let ticks = 0;
  const poller = new Poller(() => { ticks += 1; }, fake.scheduler, 500);
  poller.start();
  assert.equal(poller.running, true);
  assert.equal(poller.activeTimers, 1);
  fake.fireAll();
  assert.equal(ticks, 1);
  assert.equal(fake.timers[0]?.intervalMs, 500);
});

test('public/stop-cancels-timer', () => {
  const fake = fakeScheduler();
  let ticks = 0;
  const poller = new Poller(() => { ticks += 1; }, fake.scheduler);
  poller.start();
  poller.stop();
  assert.equal(poller.running, false);
  assert.equal(poller.activeTimers, 0);
  fake.fireAll();
  assert.equal(ticks, 0);
  assert.equal(fake.live().length, 0);
});

test('public/repeated-start-keeps-one-timer', () => {
  const fake = fakeScheduler();
  const poller = new Poller(() => {}, fake.scheduler);
  poller.start();
  poller.start();
  poller.start();
  assert.equal(fake.live().length, 1);
  assert.equal(poller.activeTimers, 1);
});

test('public/restart-after-stop', () => {
  const fake = fakeScheduler();
  let ticks = 0;
  const poller = new Poller(() => { ticks += 1; }, fake.scheduler);
  poller.start();
  poller.stop();
  poller.start();
  fake.fireAll();
  assert.equal(ticks, 1);
  assert.equal(fake.live().length, 1);
});

test('public/stop-without-start-is-safe', () => {
  const fake = fakeScheduler();
  const poller = new Poller(() => {}, fake.scheduler);
  poller.stop();
  assert.equal(poller.running, false);
  assert.equal(poller.activeTimers, 0);
  assert.equal(fake.timers.length, 0);
});

test('public/default-interval-is-used', () => {
  const fake = fakeScheduler();
  new Poller(() => {}, fake.scheduler).start();
  assert.equal(fake.timers[0]?.intervalMs, 1000);
});
