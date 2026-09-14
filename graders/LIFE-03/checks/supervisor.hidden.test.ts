import test from 'node:test';
import assert from 'node:assert/strict';
import { Supervisor, type Runner } from '../starter/src/supervisor.ts';

/** 可观察的 runner：记录收到的 signal，按需结算（或收到 abort 时结算）。 */
function controllable() {
  const signals: AbortSignal[] = [];
  const finishes: Array<() => void> = [];
  const runner: Runner = {
    run(signal) {
      signals.push(signal);
      return new Promise<void>(resolve => {
        signal.addEventListener('abort', () => resolve());
        finishes.push(resolve);
      });
    },
  };
  return { runner, signals, finishes };
}

const tick = async (times = 4): Promise<void> => {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
};

test('hidden/starts-and-stops', async () => {
  const control = controllable();
  const supervisor = new Supervisor(control.runner);
  assert.equal(supervisor.phase, 'idle');
  await supervisor.start();
  assert.equal(supervisor.phase, 'running');
  assert.equal(supervisor.startCount, 1);
  const stopping = supervisor.stop();
  await tick();
  assert.ok(supervisor.phase === 'stopping' || supervisor.phase === 'idle', 'phase 应为停止中或已停止，实际 ' + supervisor.phase);
  await stopping;
  assert.equal(supervisor.phase, 'idle');
  assert.equal(control.signals[0]?.aborted, true);
});

test('hidden/repeated-start-is-idempotent', async () => {
  const control = controllable();
  const supervisor = new Supervisor(control.runner);
  await supervisor.start();
  await supervisor.start();
  assert.equal(supervisor.startCount, 1);
  assert.equal(control.signals.length, 1);
  await supervisor.stop();
});

test('hidden/start-during-stop-waits-and-uses-fresh-signal', async () => {
  const control = controllable();
  const supervisor = new Supervisor(control.runner);
  await supervisor.start();
  const stopping = supervisor.stop();
  const restarting = supervisor.start();
  await stopping;
  await restarting;
  assert.equal(supervisor.startCount, 2, '停止期间的启动必须保留，实际 ' + supervisor.startCount);
  assert.equal(control.signals.length, 2);
  assert.equal(supervisor.phase, 'running');
  assert.equal(control.signals[1]?.aborted, false, '重启必须使用全新的 signal');
});

test('hidden/stop-is-idempotent', async () => {
  const control = controllable();
  const supervisor = new Supervisor(control.runner);
  await supervisor.stop();
  assert.equal(supervisor.phase, 'idle');
  await supervisor.start();
  const first = supervisor.stop();
  const second = supervisor.stop();
  await Promise.all([first, second]);
  assert.equal(supervisor.phase, 'idle');
  assert.equal(supervisor.startCount, 1);
});

test('hidden/stop-then-start-restarts-cleanly', async () => {
  const control = controllable();
  const supervisor = new Supervisor(control.runner);
  await supervisor.start();
  await supervisor.stop();
  await supervisor.start();
  assert.equal(supervisor.startCount, 2);
  assert.equal(supervisor.phase, 'running');
  assert.equal(control.signals[1]?.aborted, false);
  await supervisor.stop();
});
