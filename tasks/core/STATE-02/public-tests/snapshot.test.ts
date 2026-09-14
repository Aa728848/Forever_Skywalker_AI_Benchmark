import test from 'node:test';
import assert from 'node:assert/strict';
import { InvalidSnapshotError, UnknownStateError, UnsupportedVersionError, migrate } from '../starter/src/snapshot.ts';

function failureOf(run: () => unknown): string {
  try { run(); return 'ok'; } catch (error) {
    if (error instanceof UnsupportedVersionError) return 'version:' + error.version;
    if (error instanceof UnknownStateError) return 'state:' + error.state;
    if (error instanceof InvalidSnapshotError) return 'invalid';
    return 'other:' + String(error);
  }
}

test('public/passes-through-v2', () => {
  assert.deepEqual(migrate({ version: 2, state: 'paid' }), { version: 2, state: 'paid' });
});

test('public/migrates-v1-status-names', () => {
  assert.deepEqual(migrate({ version: 1, status: 'new' }), { version: 2, state: 'draft' });
  assert.deepEqual(migrate({ version: 1, status: 'active' }), { version: 2, state: 'placed' });
  assert.deepEqual(migrate({ version: 1, status: 'done' }), { version: 2, state: 'shipped' });
  assert.equal(failureOf(() => migrate({ version: 1, status: 'legacy-unknown' })), 'state:legacy-unknown');
});

test('public/rejects-unknown-version', () => {
  assert.equal(failureOf(() => migrate({ version: 3, state: 'draft' })), 'version:3');
  assert.equal(failureOf(() => migrate({ state: 'draft' })), 'version:undefined');
});

test('public/rejects-invalid-snapshots', () => {
  assert.equal(failureOf(() => migrate(null)), 'invalid');
  assert.equal(failureOf(() => migrate('x')), 'invalid');
  assert.equal(failureOf(() => migrate({ version: 2, state: 'unknown-state' })), 'invalid');
  assert.equal(failureOf(() => migrate({ version: 1 })), 'invalid');
});

test('public/migration-is-idempotent', () => {
  const once = migrate({ version: 1, status: 'done' });
  assert.deepEqual(migrate(once), once);
  assert.deepEqual(migrate({ version: 2, state: 'cancelled' }), { version: 2, state: 'cancelled' });
});
