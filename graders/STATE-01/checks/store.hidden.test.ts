import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CorruptRecordError, StoreClosedError, openRecordStore } from '../starter/src/store.ts';

function withStore(run: (directory: string, store: ReturnType<typeof openRecordStore>) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'state-01-'));
  const store = openRecordStore(directory);
  try {
    run(directory, store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('hidden/round-trips-values', () => {
  withStore((_directory, store) => {
    store.write('alpha', JSON.stringify({ nested: ['中文', '🚀'] }));
    assert.equal(store.read('alpha'), JSON.stringify({ nested: ['中文', '🚀'] }));
    store.write('alpha', 'new');
    assert.equal(store.read('alpha'), 'new');
  });
});

test('hidden/detects-tampered-checksum', () => {
  withStore((directory, store) => {
    store.write('beta', 'original');
    const path = join(directory, 'beta.rec');
    const record = JSON.parse(readFileSync(path, 'utf8')) as { checksum: string; value: string };
    writeFileSync(path, JSON.stringify({ checksum: record.checksum, value: 'tampered' }));
    assert.throws(() => store.read('beta'), CorruptRecordError);
    writeFileSync(path, '不是 JSON');
    assert.throws(() => store.read('beta'), CorruptRecordError);
  });
});

test('hidden/empty-value-round-trips', () => {
  withStore((_directory, store) => {
    store.write('empty', '');
    store.write('spaces', '   ');
    assert.equal(store.read('empty'), '');
    assert.equal(store.read('spaces'), '   ');
  });
});

test('hidden/missing-key-and-invalid-key', () => {
  withStore((_directory, store) => {
    assert.equal(store.read('nope'), null);
    assert.throws(() => store.read('../escape'), RangeError);
    assert.throws(() => store.write('a/b', 'x'), RangeError);
  });
});

test('hidden/atomic-write-leaves-no-temp-files', () => {
  withStore((directory, store) => {
    store.write('gamma', 'value');
    store.write('epsilon', 'v2');
    assert.deepEqual(readdirSync(directory).sort(), ['epsilon.rec', 'gamma.rec']);
  });
});

test('hidden/closed-store-rejects-operations', () => {
  const directory = mkdtempSync(join(tmpdir(), 'state-01-'));
  const store = openRecordStore(directory);
  try {
    store.write('delta', 'x');
    store.close();
    assert.throws(() => store.read('delta'), StoreClosedError);
    assert.throws(() => store.write('delta', 'y'), StoreClosedError);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
