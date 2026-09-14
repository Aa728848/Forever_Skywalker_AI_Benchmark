import test from 'node:test';
import assert from 'node:assert/strict';
import { JobRunner, type EffectLedger, type JobEvent, type JobStore } from '../starter/src/job-runner.ts';

/** 假存储 + 假账本：账本记录每个副作用被真正执行了几次，并可注入一次崩溃。 */
function harness(options: { crashAfterApply?: boolean; crashOnFirstWrite?: boolean } = {}) {
  const values = new Map<string, string>();
  const counts = new Map<string, number>();
  let crashArmed = options.crashOnFirstWrite === true;
  let crashBudget = 1;
  const store: JobStore = {
    read(key) { return values.get(key) ?? null; },
    write(key, value) {
      if (crashArmed) {
        crashArmed = false;
        throw new Error('模拟进程崩溃');
      }
      values.set(key, value);
    },
  };
  const ledger: EffectLedger = {
    has(effectId) { return counts.has(effectId); },
    apply(effectId) {
      counts.set(effectId, (counts.get(effectId) ?? 0) + 1);
      if (options.crashAfterApply === true && crashBudget > 0) {
        crashBudget -= 1;
        crashArmed = true;
      }
    },
  };
  return { store, ledger, counts };
}

function event(id: string, seq: number, kind: JobEvent['kind'], payload?: string): JobEvent {
  return payload === undefined ? { id, seq, kind } : { id, seq, kind, payload };
}

test('hidden/crash-after-effect-does-not-double-apply', () => {
  const h = harness({ crashAfterApply: true });
  const events = [event('e1', 1, 'add', 't1'), event('e2', 2, 'commit', 't1')];
  const runner = new JobRunner(h.store, h.ledger);
  assert.throws(() => runner.apply(events), /模拟进程崩溃/);
  const restarted = new JobRunner(h.store, h.ledger);
  restarted.resume(events);
  assert.equal(h.counts.get('e1'), 1);
  assert.equal(h.counts.get('e2'), 1);
  assert.deepEqual(restarted.state().committed, ['t1']);
  assert.deepEqual(restarted.state().pending, []);
});

test('hidden/resume-drains-pending-effects', () => {
  const h = harness({ crashOnFirstWrite: true });
  const events = [event('e1', 1, 'add', 't1')];
  const runner = new JobRunner(h.store, h.ledger);
  assert.throws(() => runner.apply(events), /模拟进程崩溃/);
  const restarted = new JobRunner(h.store, h.ledger);
  restarted.resume(events);
  assert.equal(h.counts.get('e1'), 1);
  assert.deepEqual(restarted.state().pending, ['t1']);
});

test('hidden/effect-ledger-is-the-authority', () => {
  const h = harness();
  h.counts.set('e1', 1);
  const runner = new JobRunner(h.store, h.ledger);
  runner.apply([event('e1', 1, 'add', 't1')]);
  assert.equal(h.counts.get('e1'), 1);
  assert.deepEqual(runner.state().pending, ['t1']);
});

test('hidden/out-of-order-and-duplicate-mix', () => {
  const h = harness();
  const runner = new JobRunner(h.store, h.ledger);
  runner.apply([event('e2', 2, 'add', 't2')]);
  const outcome = runner.apply([
    event('e1', 1, 'add', 't1'),
    event('e4', 4, 'commit', 't2'),
    event('e3', 3, 'add', 't3'),
    event('e2', 2, 'add', 't2'),
    event('e4', 4, 'commit', 't2'),
  ]);
  assert.deepEqual(outcome.applied, ['e3', 'e4']);
  assert.deepEqual(outcome.skipped, ['e1', 'e2', 'e4']);
  assert.equal(h.counts.get('e1'), undefined);
  assert.equal(h.counts.get('e2'), 1);
  assert.equal(h.counts.get('e3'), 1);
  assert.equal(h.counts.get('e4'), 1);
  assert.deepEqual(runner.state().committed, ['t2']);
  assert.deepEqual(runner.state().pending, ['t3']);
});

test('hidden/new-runner-reads-state-from-store', () => {
  const h = harness();
  const runner = new JobRunner(h.store, h.ledger);
  runner.apply([event('e1', 1, 'add', 't1'), event('e2', 2, 'cancel', 't1'), event('e3', 3, 'add', 't9')]);
  const fresh = new JobRunner(h.store, h.ledger);
  assert.deepEqual(fresh.state(), { committed: [], pending: ['t9'], lastSeq: 3 });
  assert.doesNotThrow(() => new JobRunner(h.store, { has: () => { throw new Error('构造不应读取账本'); }, apply: () => { throw new Error('构造不应写入账本'); } }));
});
