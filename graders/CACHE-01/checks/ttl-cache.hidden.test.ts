import test from 'node:test';
import assert from 'node:assert/strict';
import { TtlCache } from '../starter/src/ttl-cache.ts';

/** 可控时钟：测试显式推进时间，不依赖真实计时。 */
function clock(start = 1_000) {
  let current = start;
  return {
    now: () => current,
    advance: (milliseconds: number) => { current += milliseconds; },
  };
}

test('hidden/lru-order-across-many-keys', () => {
  const time = clock();
  const cache = new TtlCache<number>(3, { now: time.now });
  for (const key of ['a', 'b', 'c']) cache.set(key, key.length);
  cache.get('a');
  cache.get('b');
  cache.set('d', 4);
  assert.deepEqual(['a', 'b', 'c', 'd'].filter(key => cache.has(key)), ['a', 'b', 'd']);
});

test('hidden/refresh-then-evict-keeps-refreshed', () => {
  const time = clock();
  const cache = new TtlCache<number>(2, { now: time.now });
  cache.set('first', 1);
  cache.set('second', 2);
  time.advance(5);
  cache.get('first');
  cache.set('third', 3);
  assert.equal(cache.has('first'), true);
  assert.equal(cache.has('second'), false);
});

test('hidden/expired-entries-are-not-counted', () => {
  const time = clock();
  const cache = new TtlCache<number>(5, { now: time.now, ttlMs: 10 });
  cache.set('a', 1);
  cache.set('b', 2, { ttlMs: 1000 });
  time.advance(10);
  assert.equal(cache.size, 1);
  assert.equal(cache.has('a'), false);
  assert.equal(cache.get('b'), 2);
});

test('hidden/ttl-per-entry-overrides-default', () => {
  const time = clock();
  const cache = new TtlCache<string>(4, { now: time.now, ttlMs: 1000 });
  cache.set('short', 'v', { ttlMs: 50 });
  cache.set('long', 'v');
  time.advance(50);
  assert.equal(cache.has('short'), false);
  assert.equal(cache.has('long'), true);
});

test('hidden/has-does-not-refresh-recency', () => {
  const time = clock();
  const cache = new TtlCache<number>(2, { now: time.now });
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.has('a'), true);
  cache.set('c', 3);
  assert.equal(cache.has('a'), false);
  assert.equal(cache.has('b'), true);
});

test('hidden/clear-and-delete-semantics', () => {
  const time = clock();
  const cache = new TtlCache<number>(4, { now: time.now });
  cache.set('a', 1);
  assert.equal(cache.delete('a'), true);
  assert.equal(cache.delete('a'), false);
  cache.set('b', 2);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.get('b'), undefined);
});
