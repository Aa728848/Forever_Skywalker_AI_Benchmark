import test from 'node:test';
import assert from 'node:assert/strict';
import { DuplicateProviderError, InvalidProviderError, resolveProviders, type Provider } from '../starter/src/providers.ts';

function failureOf(run: () => unknown): string {
  try { run(); return 'ok'; } catch (error) {
    if (error instanceof DuplicateProviderError) return 'duplicate:' + error.id;
    if (error instanceof InvalidProviderError) return 'invalid:' + error.id;
    return 'other:' + String(error);
  }
}

const catalog: Provider[] = [
  { id: 'core-cache', runtime: 'shared', label: '共享缓存' },
  { id: 'browser-cache', runtime: 'shared', label: '名字像浏览器其实是共享' },
  { id: 'web-telemetry', runtime: 'browser', label: '浏览器专属但没前缀' },
  { id: 'node-fs', runtime: 'node', label: 'Node 专属' },
];

test('public/keeps-shared-and-matching', () => {
  const resolved = resolveProviders(catalog, 'node');
  assert.deepEqual(resolved.usable.map(provider => provider.id), ['core-cache', 'browser-cache', 'node-fs']);
  assert.deepEqual(resolved.skipped, ['web-telemetry']);
});

test('public/browser-side-skips-node-only', () => {
  const resolved = resolveProviders(catalog, 'browser');
  assert.deepEqual(resolved.usable.map(provider => provider.id), ['core-cache', 'browser-cache', 'web-telemetry']);
  assert.deepEqual(resolved.skipped, ['node-fs']);
});

test('public/preserves-catalog-order', () => {
  const resolved = resolveProviders(catalog, 'browser');
  const original = catalog.map(provider => provider.id);
  const positions = resolved.usable.map(provider => original.indexOf(provider.id));
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
});

test('public/rejects-duplicate-and-invalid-metadata', () => {
  assert.equal(failureOf(() => resolveProviders([...catalog, { id: 'core-cache', runtime: 'node', label: '重复' }], 'node')), 'duplicate:core-cache');
  assert.equal(failureOf(() => resolveProviders([{ id: 'bad', runtime: 'desktop' as 'node', label: '非法' }], 'node')), 'invalid:bad');
  assert.equal(failureOf(() => resolveProviders([{ id: '', runtime: 'shared', label: '无 id' }], 'node')), 'invalid:');
});

test('public/empty-catalog-is-empty-result', () => {
  assert.deepEqual(resolveProviders([], 'node'), { usable: [], skipped: [] });
});
