import test from 'node:test';
import assert from 'node:assert/strict';
import { AdapterError, Repository, type AdapterV2, type LegacyAdapter } from '../starter/src/repository.ts';

const legacyAdapter: LegacyAdapter = {
  fetch(id) {
    if (id === 'missing') return { ok: false, ms: 12 };
    if (id === 'boom') throw new Error('legacy 故障');
    return { ok: true, ms: 34, payload: 'L:' + id };
  },
};

function v2Adapter(): AdapterV2 {
  return {
    async load(id) {
      if (id === 'missing') return { status: 'missing', durationSeconds: 0.02, body: null };
      if (id === 'boom') throw new Error('v2 故障');
      return { status: 'ok', durationSeconds: 0.25, body: 'V:' + id };
    },
  };
}

async function failureOf(run: () => Promise<unknown>): Promise<string> {
  try { await run(); return 'ok'; } catch (error) {
    if (error instanceof AdapterError) return 'adapter:' + error.id;
    return 'other:' + String(error);
  }
}

test('public/legacy-adapter-keeps-contract', async () => {
  const repository = new Repository(legacyAdapter);
  assert.deepEqual(await repository.read('a'), { ok: true, durationMs: 34, body: 'L:a' });
  assert.deepEqual(await repository.read('missing'), { ok: false, durationMs: 12, body: null });
});

test('public/v2-status-maps-to-ok', async () => {
  const repository = new Repository(v2Adapter());
  assert.deepEqual(await repository.read('missing'), { ok: false, durationMs: 20, body: null });
  const hit = await repository.read('b');
  assert.equal(hit.ok, true);
  assert.equal(hit.body, 'V:b');
});

test('public/v2-seconds-become-milliseconds', async () => {
  const repository = new Repository(v2Adapter());
  assert.equal((await repository.read('c')).durationMs, 250);
});

test('public/adapter-failures-are-normalized', async () => {
  assert.equal(await failureOf(() => new Repository(legacyAdapter).read('boom')), 'adapter:boom');
  assert.equal(await failureOf(() => new Repository(v2Adapter()).read('boom')), 'adapter:boom');
});

test('public/adapter-object-is-not-mutated', async () => {
  const adapter = v2Adapter();
  const before = Object.keys(adapter).sort();
  await new Repository(adapter).read('d');
  assert.deepEqual(Object.keys(adapter).sort(), before);
});
