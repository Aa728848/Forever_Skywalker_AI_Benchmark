import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { auto, policy, events, reviewed, editAfter, fixture, setCompletion, completion, VerifierEngine, SingleFlight, ScoreCache } from '../public-tests/support.mjs';

test('hidden/failed-write-and-wrong-session-do-not-reuse-verdict', () => {
  assert.equal(auto.analyzeAutoTask(editAfter(reviewed(events()), true), policy, 'session-local').manualVerificationAccepted, false);
  assert.equal(auto.analyzeAutoTask(reviewed(events(), { sessionId: 'another-session' }), policy, 'session-local').manualVerificationAccepted, false);
});
test('hidden/criteria-loss-cannot-be-hidden-by-perfect-mean', () => {
  for (const criteria of [[], [{ id: 'a' }], [{ id: 'a', score: 1 }, { id: 'b', score: 0 }]]) {
    assert.equal(auto.analyzeAutoTask(reviewed(events(), { criteria }), policy, 'session-local').manualVerificationAccepted, false);
  }
});
test('hidden/cache-identity-covers-prompt-and-rule-version', async () => {
  const f = fixture(); let calls = 0; setCompletion(async () => { calls += 1; return completion(); });
  try {
    const engine = new VerifierEngine(f.client('same-model'), 2, f.cache);
    await engine.compare(f.compare);
    await engine.compare({ ...f.compare, groundTruthNote: 'rubric-v2: verify a changed frozen requirement' });
    await engine.compare({ ...f.compare, candidateA: 'new snapshot implementation' });
    assert.equal(calls, 3);
  } finally { f.cleanup(); }
});
test('hidden/concurrent-engines-share-one-flight-and-one-cost', async () => {
  const f = fixture(); const flights = new SingleFlight(); let calls = 0;
  let release; const barrier = new Promise(resolve => { release = resolve; });
  let started; const began = new Promise(resolve => { started = resolve; });
  setCompletion(async () => { calls += 1; started(); await barrier; return completion(); });
  try {
    const first = new VerifierEngine(f.client('shared'), 2, f.cache, { input: 0, output: 0 }, flights).compare(f.compare);
    const second = new VerifierEngine(f.client('shared'), 2, new ScoreCache(join(f.directory, 'scores.json'), 8), { input: 0, output: 0 }, flights).compare(f.compare);
    await began; release(); const results = await Promise.all([first, second]);
    assert.equal(calls, 1); assert.equal(results.reduce((sum, result) => sum + result.stats.calls, 0), 1);
  } finally { release(); f.cleanup(); }
});
test('hidden/failed-flight-can-retry-and-disk-cache-stays-bounded', async () => {
  const f = fixture(); let calls = 0;
  setCompletion(async () => { calls += 1; if (calls === 1) throw new Error('synthetic endpoint failed'); return completion(); });
  try {
    const engine = new VerifierEngine(f.client('resource-check'), 2, f.cache);
    await assert.rejects(engine.compare(f.compare));
    for (let index = 0; index < 12; index += 1) await engine.compare({ ...f.compare, problem: 'snapshot-' + index });
    assert.ok(Object.keys(JSON.parse(readFileSync(join(f.directory, 'scores.json'), 'utf8')).entries).length <= 8);
    assert.equal(calls, 13);
  } finally { f.cleanup(); }
});
