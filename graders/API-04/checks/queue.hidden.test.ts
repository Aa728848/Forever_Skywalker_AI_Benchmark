import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DurableQueue, QueueError, type Lease, type QueueSnapshot } from '../starter/src/queue.ts';
import { runOne } from '../starter/src/worker.ts';

const processWorker = fileURLToPath(new URL('./process-worker.ts', import.meta.url));
function workspace() {
  const directory = mkdtempSync(join(tmpdir(), 'api04-hidden-'));
  return { path: join(directory, 'queue.db'), dispose: () => rmSync(directory, { recursive: true, force: true }) };
}
function crash(path: string, operation: string, phase: string, lease?: Lease) {
  const child = spawnSync(process.execPath, [processWorker, JSON.stringify({ path, operation, crash: phase, lease })], {
    windowsHide: true, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 86, child.stdout + child.stderr);
}
function errorCode(code: QueueError['code']) {
  return (error: unknown) => error instanceof QueueError && error.code === code;
}

test('hidden/durable-crash-submit', () => {
  const w = workspace();
  try {
    crash(w.path, 'submit', 'submit-written');
    const q = new DurableQueue(w.path);
    try {
      assert.equal(q.snapshot().tasks.length, 0, '无确认提交不能恢复成半条任务');
      assert.equal(q.snapshot().revision, 0);
      const id = q.submit('child-request', 'child-payload');
      assert.equal(q.submit('child-request', 'child-payload'), id);
    } finally { q.close(); }
  } finally { w.dispose(); }
});

test('hidden/durable-crash-claim', () => {
  const w = workspace();
  let q = new DurableQueue(w.path);
  try {
    q.submit('job', 'payload');
    q.close();
    crash(w.path, 'claim', 'claim-written');
    q = new DurableQueue(w.path);
    assert.equal(q.snapshot().tasks[0]?.state, 'queued');
    assert.equal(q.snapshot().revision, 1);
    assert.ok(q.claim('replacement', 0, 10));
  } finally { q.close(); w.dispose(); }
});

test('hidden/durable-crash-result', () => {
  const w = workspace();
  let q = new DurableQueue(w.path);
  try {
    q.submit('job', 'payload');
    const lease = q.claim('worker', 0, 10)!;
    q.close();
    crash(w.path, 'complete', 'result-written', lease);
    q = new DurableQueue(w.path);
    assert.equal(q.snapshot().results.length, 0, '结果和完成状态必须同时恢复');
    assert.equal(q.snapshot().tasks[0]?.state, 'leased');
    assert.equal(q.snapshot().revision, 2);
    assert.equal(q.complete(lease, 'retried result', 2), true);
  } finally { q.close(); w.dispose(); }
});

test('hidden/durable-lost-ack-replay', () => {
  const w = workspace();
  let q: DurableQueue | undefined;
  try {
    crash(w.path, 'submit', 'committed');
    q = new DurableQueue(w.path);
    const existing = q.snapshot().tasks[0]!;
    assert.equal(q.submit('child-request', 'child-payload'), existing.id);
    const lease = q.claim('worker', 0, 10)!;
    q.close();
    crash(w.path, 'complete', 'committed', lease);
    q = new DurableQueue(w.path);
    assert.equal(q.complete(lease, 'child-result', 999), true);
    assert.throws(() => q!.complete(lease, 'changed', 999), errorCode('conflict'));
    assert.equal(q.snapshot().results.length, 1);
    assert.equal(q.snapshot().revision, 3);
  } finally { q?.close(); w.dispose(); }
});

test('hidden/durable-competing-claim', async () => {
  const w = workspace();
  const competitor = new DurableQueue(w.path, { busyTimeoutMs: 20 });
  competitor.submit('one-job', 'payload');
  const child = spawn(process.execPath, [processWorker, JSON.stringify({ path: w.path, operation: 'claim', hold: 'claim-selected' })], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  let errors = '';
  let readyResolve!: () => void;
  let readyReject!: (reason: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const guard = setTimeout(() => { child.kill(); readyReject(new Error('child did not reach barrier')); }, 10000);
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', error => { readyReject(error); reject(error); });
    child.once('close', code => { readyReject(new Error('child exited before barrier: ' + errors)); resolve(code); });
  });
  child.stdout.on('data', chunk => { output += chunk.toString(); if (output.includes('"checkpoint"')) readyResolve(); });
  child.stderr.on('data', chunk => { errors += chunk.toString(); });
  try {
    await ready;
    let second: Lease | null = null;
    let busy = false;
    try { second = competitor.claim('second-worker', 0, 100); }
    catch (error) { assert.ok(errorCode('busy')(error), String(error)); busy = true; }
    child.stdin.end('x');
    assert.equal(await exited, 0, errors);
    const first = (JSON.parse(output.trim().split('\n').at(-1)!) as { value: Lease | null }).value;
    if (busy) second = competitor.claim('second-worker', 0, 100);
    assert.equal([first, second].filter(Boolean).length, 1, '同一任务不能同时确认两个有效领取');
    assert.equal(competitor.snapshot().tasks[0]?.owner, (first ?? second)!.worker);
  } finally {
    clearTimeout(guard);
    if (child.exitCode === null) { child.stdin.end('x'); child.kill(); await exited; }
    competitor.close(); w.dispose();
  }
});

test('hidden/durable-same-worker-stale-completion', () => {
  const w = workspace();
  const q = new DurableQueue(w.path);
  try {
    q.submit('work', 'payload');
    const old = q.claim('reused-worker-name', 0, 10)!;
    const current = q.claim('reused-worker-name', 10, 10)!;
    assert.equal(q.complete(old, 'obsolete', 11), false, 'worker 名称相同不能授权旧代际');
    assert.equal(q.complete({ ...current, expiresAt: current.expiresAt + 1 }, 'forged', 11), false);
    assert.equal(q.complete(current, 'accepted', 11), true);
  } finally { q.close(); w.dispose(); }
});

test('hidden/durable-worker-replay-boundary', async () => {
  const w = workspace();
  const q = new DurableQueue(w.path);
  let now = 0;
  let release!: (value: string) => void;
  const effects: string[] = [];
  try {
    q.submit('work', 'payload');
    const old = runOne(q, 'worker', () => now, 10, async payload => {
      effects.push(payload);
      return new Promise<string>(resolve => { release = resolve; });
    });
    now = 10;
    assert.equal(await runOne(q, 'worker', () => now, 10, async payload => { effects.push(payload); return 'new'; }), 'completed');
    now = 11;
    release('old');
    assert.equal(await old, 'superseded');
    assert.equal(effects.length, 2, '外部执行可能重放，不能冒称副作用恰好一次');
    assert.deepEqual(q.snapshot().results.map(row => row.value), ['new']);
  } finally { q.close(); w.dispose(); }
});

test('hidden/durable-idempotent-resource-bound', () => {
  const w = workspace();
  const q = new DurableQueue(w.path);
  try {
    const id = q.submit('stable', 'payload');
    const lease = q.claim('worker', 0, 10)!;
    q.complete(lease, 'result', 1);
    const bytes = statSync(w.path).size;
    for (let i = 0; i < 1000; i += 1) {
      assert.equal(q.submit('stable', 'payload'), id);
      assert.equal(q.complete(lease, 'result', 1000), true);
    }
    assert.equal(q.snapshot().revision, 3);
    assert.equal(q.snapshot().tasks.length, 1);
    assert.equal(q.snapshot().results.length, 1);
    assert.equal(statSync(w.path).size, bytes, '幂等重放不能追加持久历史');
  } finally { q.close(); w.dispose(); }
});

test('hidden/durable-boundaries-and-snapshot', () => {
  const w = workspace();
  const q = new DurableQueue(w.path);
  try {
    for (const [worker, now, lease] of [['', 0, 10], ['w', NaN, 10], ['w', 1, 0], ['w', 1, Infinity], ['w', Number.MAX_SAFE_INTEGER, 1]] as const) {
      assert.throws(() => q.claim(worker, now, lease), errorCode('invalid'));
    }
    assert.throws(() => q.submit('', 'payload'), errorCode('invalid'));
    const ids = ['../escape', '__proto__', '空键\u0000|line\n'].map(key => q.submit(key, 'p|\n'));
    assert.equal(new Set(ids).size, 3);
    const snapshot = q.snapshot(); snapshot.tasks[0]!.state = 'completed'; snapshot.tasks.length = 0;
    assert.equal(q.snapshot().tasks.length, 3);
    assert.equal(q.snapshot().tasks[0]?.state, 'queued');
    q.close(); q.close();
    assert.throws(() => q.snapshot(), errorCode('closed'));
    assert.throws(() => q.submit('closed', 'p'), errorCode('closed'));
  } finally { q.close(); w.dispose(); }
});

test('hidden/durable-fixed-seed-state-machine', () => {
  const w = workspace();
  let q = new DurableQueue(w.path);
  const expected: QueueSnapshot = { revision: 0, tasks: [], results: [] };
  const leases: Lease[] = [];
  let seed = 0x51a7;
  let now = 0;
  function next(max: number) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; }
  try {
    for (let step = 0; step < 120; step += 1) {
      now += next(4);
      const action = step < 3 ? step : next(3);
      if (action === 0) {
        const key = 'key-' + next(9);
        const payload = next(4) === 0 ? 'variant' : 'payload';
        const prior = expected.tasks.find(row => row.key === key);
        if (prior && prior.payload !== payload) assert.throws(() => q.submit(key, payload), errorCode('conflict'));
        else {
          const id = q.submit(key, payload);
          if (prior) assert.equal(id, prior.id);
          else { expected.tasks.push({ id, key, payload, state: 'queued', generation: 0, owner: null, leaseUntil: null }); expected.revision += 1; }
        }
      } else if (action === 1) {
        const worker = 'worker-' + next(2);
        const row = expected.tasks.find(item => item.state === 'queued' || (item.state === 'leased' && item.leaseUntil! <= now));
        const actual = q.claim(worker, now, 3);
        if (!row) assert.equal(actual, null);
        else {
          row.state = 'leased'; row.owner = worker; row.generation += 1; row.leaseUntil = now + 3; expected.revision += 1;
          assert.deepEqual(actual, { taskId: row.id, worker, generation: row.generation, expiresAt: row.leaseUntil });
          leases.push(actual!);
        }
      } else if (leases.length > 0) {
        const lease = leases[next(leases.length)]!;
        const row = expected.tasks.find(item => item.id === lease.taskId)!;
        const result = 'result-' + lease.generation;
        const valid = row.owner === lease.worker && row.generation === lease.generation && row.leaseUntil === lease.expiresAt;
        const accepted = valid && (row.state === 'completed' || now < row.leaseUntil!);
        assert.equal(q.complete(lease, result, now), accepted);
        if (accepted && row.state !== 'completed') { row.state = 'completed'; expected.results.push({ taskId: row.id, value: result }); expected.revision += 1; }
      }
      assert.deepEqual(JSON.parse(JSON.stringify(q.snapshot())), expected);
      if (step % 13 === 12) { q.close(); q = new DurableQueue(w.path); }
    }
  } finally { q.close(); w.dispose(); }
});
