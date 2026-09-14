import test from 'node:test';
import assert from 'node:assert/strict';
import { VersionedCache, type CachePort } from '../starter/src/cache.ts';

function controllablePort() {
  const calls: Array<{ key: string; resolve: (value: string) => void }> = [];
  const port: CachePort = {
    load(key) {
      return new Promise<string>(resolve => { calls.push({ key, resolve }); });
    },
  };
  return { port, calls, resolve: (index: number, value: string) => calls[index]?.resolve(value) };
}

test('hidden/caches-on-miss-and-reuses-hit', async () => {
  const fake = controllablePort();
  const cache = new VersionedCache(fake.port);
  const first = cache.get('a');
  fake.resolve(0, 'v1');
  assert.equal(await first, 'v1');
  assert.equal(await cache.get('a'), 'v1');
  assert.equal(fake.calls.length, 1, '命中不得再次 load');
});

test('hidden/invalidate-forces-reload', async () => {
  const fake = controllablePort();
  const cache = new VersionedCache(fake.port);
  const first = cache.get('a');
  fake.resolve(0, 'v1');
  await first;
  cache.invalidate('a');
  assert.equal(cache.version('a'), 1);
  const second = cache.get('a');
  assert.equal(fake.calls.length, 2);
  fake.resolve(1, 'v2');
  assert.equal(await second, 'v2');
});

test('hidden/discards-inflight-result-invalidated-before-settle', async () => {
  const fake = controllablePort();
  const cache = new VersionedCache(fake.port);
  const inflight = cache.get('a');
  cache.invalidate('a');
  fake.resolve(0, 'stale');
  assert.equal(await inflight, 'stale', '调用方仍应拿到它请求时的结果');
  const after = cache.get('a');
  assert.equal(fake.calls.length, 2, '失效后的在途结果不得命中缓存');
  fake.resolve(1, 'fresh');
  assert.equal(await after, 'fresh');
});

test('hidden/second-invalidate-during-flight-keeps-latest-request', async () => {
  const fake = controllablePort();
  const cache = new VersionedCache(fake.port);
  const inflight = cache.get('k');
  cache.invalidate('k');
  const reload = cache.get('k');
  cache.invalidate('k');
  fake.resolve(0, 'old');
  fake.resolve(1, 'mid');
  assert.equal(await inflight, 'old');
  assert.equal(await reload, 'mid');
  assert.equal(cache.version('k'), 2);
  const latest = cache.get('k');
  assert.equal(fake.calls.length, 3);
  fake.resolve(2, 'newest');
  assert.equal(await latest, 'newest');
});

test('hidden/keys-are-independent', async () => {
  const fake = controllablePort();
  const cache = new VersionedCache(fake.port);
  const alpha = cache.get('alpha');
  cache.invalidate('beta');
  fake.resolve(0, 'A');
  assert.equal(await alpha, 'A');
  assert.equal(await cache.get('alpha'), 'A');
  assert.equal(cache.version('beta'), 1);
  assert.equal(cache.version('alpha'), 0);
});
