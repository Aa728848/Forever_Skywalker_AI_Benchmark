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

test('public/applies-batch-in-seq-order', () => {
  const h = harness();
  const runner = new JobRunner(h.store, h.ledger);
  const outcome = runner.apply([event('c', 3, 'commit', 't2'), event('a', 1, 'add', 't1'), event('b', 2, 'add', 't2')]);
  assert.deepEqual(outcome.applied, ['a', 'b', 'c']);
  assert.deepEqual(outcome.skipped, []);
  assert.deepEqual(new Set(h.counts.keys()), new Set(['a', 'b', 'c']));
  assert.deepEqual(runner.state().committed, ['t2']);
});

test('public/duplicate-event-ids-are-skipped', () => {
  const h = harness();
  const runner = new JobRunner(h.store, h.ledger);
  const outcome = runner.apply([event('e1', 1, 'add', 't1'), event('e1', 1, 'add', 't1'), event('e2', 2, 'add', 't2')]);
  assert.deepEqual(outcome.applied, ['e1', 'e2']);
  assert.deepEqual(outcome.skipped, ['e1']);
  assert.equal(h.counts.get('e1'), 1);
});

test('public/late-events-are-ignored', () => {
  const h = harness();
  const runner = new JobRunner(h.store, h.ledger);
  runner.apply([event('e2', 2, 'add', 't2')]);
  const outcome = runner.apply([event('e1', 1, 'add', 't1')]);
  assert.deepEqual(outcome.applied, []);
  assert.deepEqual(outcome.skipped, ['e1']);
  assert.deepEqual(runner.state().pending, ['t2']);
  assert.equal(h.counts.has('e1'), false);
});

test('public/effects-are-applied-once-per-id', () => {
  const h = harness();
  const runner = new JobRunner(h.store, h.ledger);
  const events = [event('e1', 1, 'add', 't1'), event('e2', 2, 'commit', 't1')];
  runner.apply(events);
  const second = runner.apply(events);
  assert.deepEqual(second.applied, []);
  assert.deepEqual(second.skipped, ['e1', 'e2']);
  assert.equal(h.counts.get('e1'), 1);
  assert.equal(h.counts.get('e2'), 1);
});

test('public/state-is-persisted', () => {
  const h = harness();
  const runner = new JobRunner(h.store, h.ledger);
  runner.apply([event('e1', 1, 'add', 't1'), event('e2', 2, 'add', 't2'), event('e3', 3, 'commit', 't1')]);
  const restarted = new JobRunner(h.store, h.ledger);
  assert.deepEqual(restarted.state(), runner.state());
  assert.deepEqual(restarted.state().committed, ['t1']);
  assert.deepEqual(restarted.state().pending, ['t2']);
  assert.equal(restarted.state().lastSeq, 3);
});

test('public/empty-batch-is-a-no-op', () => {
  const h = harness();
  const runner = new JobRunner(h.store, h.ledger);
  const outcome = runner.apply([]);
  assert.deepEqual(outcome, { applied: [], skipped: [] });
  assert.deepEqual(runner.state(), { committed: [], pending: [], lastSeq: 0 });
  assert.equal(h.counts.size, 0);
});
