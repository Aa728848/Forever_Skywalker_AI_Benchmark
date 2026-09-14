import test from 'node:test';
import assert from 'node:assert/strict';
import { LockManager } from '../starter/src/locks.ts';

function markers(count: number): Array<{ value: string }> {
  return Array.from({ length: count }, () => ({ value: 'pending' }));
}

test('hidden/grants-when-free', async () => {
  const locks = new LockManager();
  const release = await locks.acquire('db');
  assert.equal(locks.queueLength, 0);
  const second = locks.acquire('db');
  assert.equal(locks.queueLength, 1);
  release();
  await second;
  assert.equal(locks.queueLength, 0);
});

test('hidden/first-come-first-served', async () => {
  const locks = new LockManager();
  const release = await locks.acquire('db');
  const order: string[] = [];
  // 故意不 await 这两个 promise：缺陷实现可能永远不会结算它们，
  // 检查用「谁先拿到资源」的副作用断言，避免把阶段挂死。
  void locks.acquire('db').then(free => { order.push('first'); return free; });
  void locks.acquire('db').then(free => { order.push('second'); return free; });
  assert.equal(locks.queueLength, 2);
  release();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(order, ['first'], '释放时必须先唤醒队首，实际 ' + JSON.stringify(order));
  assert.equal(locks.queueLength, 1, '队首获得后队列里应剩一个等待者');
});

test('hidden/newcomers-cannot-jump-the-queue', async () => {
  const locks = new LockManager();
  const release = await locks.acquire('db');
  const waiting = locks.acquire('db');
  const newcomer = locks.acquire('db');
  const seen = markers(2);
  void waiting.then(() => { seen[0] = { value: 'waiting' }; });
  void newcomer.then(() => { seen[1] = { value: 'newcomer' }; });
  release();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(seen[0].value, 'waiting', '队首必须先获得资源');
  assert.equal(seen[1].value, 'pending', '插队者不得先获得资源');
});

test('hidden/release-is-idempotent', async () => {
  const locks = new LockManager();
  const release = await locks.acquire('a');
  const waiting = locks.acquire('a');
  release();
  release();
  const free = await waiting;
  assert.equal(locks.queueLength, 0);
  free();
  free();
  assert.equal(locks.queueLength, 0);
});

test('hidden/resources-are-independent', async () => {
  const locks = new LockManager();
  const a = await locks.acquire('a');
  const b = await locks.acquire('b');
  assert.equal(locks.queueLength, 0);
  const waitingForA = locks.acquire('a');
  assert.equal(locks.queueLength, 1);
  a();
  await waitingForA;
  b();
});
