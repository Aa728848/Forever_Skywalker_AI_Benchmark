import test from 'node:test';
import assert from 'node:assert/strict';
import { auto, replay, policy, events, reviewed, editAfter, fixture, setCompletion, completion, VerifierEngine, partialStats } from './support.mjs';

test('public/current-review-closes-gate-without-reentry', () => {
  const result = auto.analyzeAutoTask(reviewed(events()), policy, 'session-local');
  assert.equal(result.manualVerificationAccepted, true);
  assert.equal(result.eligible, false);
  assert.equal(result.toolCalls, 1, '裁判本身不增加业务工作计数');
});
test('public/changed-evidence-invalidates-prior-acceptance', () => {
  const result = auto.analyzeAutoTask(editAfter(reviewed(events())), policy, 'session-local');
  assert.equal(result.manualVerificationAccepted, false);
  assert.equal(result.eligible, true);
});
test('public/missing-criteria-never-pass-the-gate', () => {
  const result = auto.analyzeAutoTask(reviewed(events(), { criteria: [] }), policy, 'session-local');
  assert.equal(result.manualVerificationAccepted, false);
  assert.equal(result.eligible, true);
});
test('public/engine-cache-isolates-judge-model', async () => {
  const f = fixture(); let calls = 0;
  setCompletion(async () => { calls += 1; return completion(); });
  try {
    const a = await new VerifierEngine(f.client('model-a'), 2, f.cache).compare(f.compare);
    const b = await new VerifierEngine(f.client('model-b'), 2, f.cache).compare(f.compare);
    assert.equal(a.winner, 'A'); assert.equal(b.winner, 'A'); assert.equal(calls, 2);
  } finally { f.cleanup(); }
});
test('public/malformed-judge-fails-and-keeps-billed-usage', async () => {
  const f = fixture(); setCompletion(async () => completion('unparseable verdict'));
  try {
    await assert.rejects(new VerifierEngine(f.client('model-a'), 1, f.cache).compare(f.compare), error => {
      assert.equal(partialStats(error)?.calls, 1); assert.equal(partialStats(error)?.outputTokens, 9); return true;
    });
  } finally { f.cleanup(); }
});
test('public/replay-uses-the-live-per-criterion-gate', () => {
  const rows = replay.sweepThresholds([{ toolName: 'verifier_current_session', score: 0.8, winner: 'A', criteria: [{ id: 'required', score: 0 }] }], [0.65]);
  assert.equal(rows[0].accepted, 0); assert.equal(rows[0].rejectedCriterion, 1);
});
