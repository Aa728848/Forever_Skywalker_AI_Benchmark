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

test('public/stores-and-returns-values', () => {
  const time = clock();
  const cache = new TtlCache<number>(3, { now: time.now });
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('b'), 2);
  assert.equal(cache.get('missing'), undefined);
  assert.equal(cache.has('a'), true);
  assert.equal(cache.size, 2);
});

test('public/capacity-evicts-least-recently-used', () => {
  const time = clock();
  const cache = new TtlCache<number>(2, { now: time.now });
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.get('a'), 1);
  cache.set('c', 3);
  assert.equal(cache.has('a'), true);
  assert.equal(cache.has('b'), false);
  assert.equal(cache.has('c'), true);
  assert.equal(cache.size, 2);
});

test('public/get-refreshes-recency', () => {
  const time = clock();
  const cache = new TtlCache<number>(2, { now: time.now });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a');
  cache.set('c', 3);
  assert.deepEqual([cache.has('a'), cache.has('b'), cache.has('c')], [true, false, true]);
});

test('public/ttl-boundary-at-expiry', () => {
  const time = clock();
  const cache = new TtlCache<string>(4, { now: time.now });
  cache.set('k', 'v', { ttlMs: 100 });
  time.advance(99);
  assert.equal(cache.get('k'), 'v');
  time.advance(1);
  assert.equal(cache.has('k'), false);
  assert.equal(cache.get('k'), undefined);
  assert.equal(cache.size, 0);
});

test('public/zero-ttl-expires-immediately', () => {
  const time = clock();
  const cache = new TtlCache<string>(4, { now: time.now, ttlMs: 1000 });
  cache.set('k', 'v', { ttlMs: 0 });
  assert.equal(cache.has('k'), false);
  assert.equal(cache.size, 0);
});

test('public/negative-ttl-is-rejected', () => {
  const time = clock();
  const cache = new TtlCache<string>(2, { now: time.now });
  assert.throws(() => cache.set('k', 'v', { ttlMs: -1 }), RangeError);
  assert.throws(() => new TtlCache<string>(0, { now: time.now }), RangeError);
});

test('public/overwrite-does-not-evict-others', () => {
  const time = clock();
  const cache = new TtlCache<number>(2, { now: time.now });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('a', 10);
  assert.equal(cache.size, 2);
  assert.equal(cache.get('a'), 10);
  assert.equal(cache.get('b'), 2);
});
