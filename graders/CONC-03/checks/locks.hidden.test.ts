import test from 'node:test';
import assert from 'node:assert/strict';
import { LockManager, type Release } from '../starter/src/locks.ts';

test('hidden/fifo-order-is-strictly-first-come-first-served', async () => {
  // 契约第 3 条：释放时把资源交给**队首**等待者。
  // 关键反例：LIFO 会让先来的请求被无限推迟。
  const manager = new LockManager();
  const order: string[] = [];
  const releases: Release[] = [];
  const first = manager.acquire('r').then(release => { order.push('A'); releases.push(release); });
  await Promise.resolve();
  for (const tag of ['B', 'C', 'D']) {
    manager.acquire('r').then(release => { order.push(tag); releases.push(release); });
    await Promise.resolve();
  }
  // A 持有中，B/C/D 排队。
  assert.deepEqual(order, ['A'], 'A 之外还有请求被授予');
  assert.equal(manager.queueLength, 3, 'queueLength 不是 3');
  // 逐个释放，授予顺序必须是 A→B→C→D。
  for (let step = 0; step < 4; step += 1) {
    releases[step]!();
    await Promise.resolve();
    await Promise.resolve();
  }
  await first;
  assert.deepEqual(order, ['A', 'B', 'C', 'D'], '授予顺序不是 FIFO：' + order.join(','));
  assert.equal(manager.queueLength, 0, '队列没有清空');
});

test('hidden/newcomers-cannot-jump-waiting-queue', async () => {
  // 契约第 2 条：资源被占用或已有等待者时，新请求必须入队，不得插队。
  const manager = new LockManager();
  const order: string[] = [];
  const releases: Release[] = [];
  const hold = await manager.acquire('r');
  // 三个请求排队。
  for (const tag of ['B', 'C', 'D']) {
    manager.acquire('r').then(release => { order.push(tag); releases.push(release); });
    await Promise.resolve();
  }
  assert.equal(manager.queueLength, 3);
  // 关键：在 B/C/D 等待时来了新请求 E。
  manager.acquire('r').then(release => { order.push('E'); releases.push(release); });
  await Promise.resolve();
  assert.equal(manager.queueLength, 4, 'E 没有进入队列');
  assert.deepEqual(order, [], '队列非空时就有请求被授予');
  // 释放后必须严格按到达顺序。
  hold();
  for (let step = 0; step < 4; step += 1) {
    await Promise.resolve();
    await Promise.resolve();
    if (releases[step] !== undefined) releases[step]();
  }
  assert.deepEqual(order, ['B', 'C', 'D', 'E'], 'E 插队了：' + order.join(','));
});

test('hidden/release-is-idempotent-and-does-not-steal-next-holder', async () => {
  // 契约第 4 条：Release 幂等，重复调用不得释放别人的锁、不得重复唤醒。
  const manager = new LockManager();
  const order: string[] = [];
  const releases: Release[] = [];
  const hold = await manager.acquire('r');
  manager.acquire('r').then(release => { order.push('B'); releases.push(release); });
  await Promise.resolve();
  assert.equal(manager.queueLength, 1);

  // 重复调用 A 的 release：只有第一次有效。
  hold();
  hold();
  hold();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(order, ['B'], '重复 release 重复唤醒了等待者');
  assert.equal(manager.queueLength, 0, 'B 被授予后队列仍有等待者');

  // B 的 release 重复调用：不得把资源释放给第三个人（此处无人等待）。
  releases[0]!();
  releases[0]!();
  releases[0]!();
  await Promise.resolve();
  assert.equal(manager.queueLength, 0);
  // 资源确实已释放：新的 acquire 能立即拿到。
  const fresh = await manager.acquire('r');
  assert.equal(typeof fresh, 'function');
  // 旧 release 再调用不得释放掉 fresh 的锁。
  releases[0]!();
  await Promise.resolve();
  const another = manager.acquire('r');
  let granted = false;
  void another.then(() => { granted = true; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(granted, false, '旧 release 释放了不属于它的锁');
  fresh();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(granted, true, 'fresh 释放后 another 没有被授予');
});

test('hidden/queue-length-counts-waiters-not-resources', async () => {
  // 契约第 5 条：queueLength 反映当前等待者总数；不同资源互不影响。
  const manager = new LockManager();
  assert.equal(manager.queueLength, 0, '初始 queueLength 不是 0');
  const a = await manager.acquire('a');
  const b = await manager.acquire('b');
  assert.equal(manager.queueLength, 0, '已授予的请求被计入了队列');
  // a 上排两个，b 上排一个。
  manager.acquire('a').catch(() => undefined);
  await Promise.resolve();
  manager.acquire('a').catch(() => undefined);
  await Promise.resolve();
  manager.acquire('b').catch(() => undefined);
  await Promise.resolve();
  assert.equal(manager.queueLength, 3, 'queueLength 不是等待者总数');
  // 释放 a 只影响 a 的队列。
  a();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(manager.queueLength, 2, '释放 a 后的 queueLength 不对');
  b();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(manager.queueLength, 1, '释放 b 后的 queueLength 不对');
  // 全部释放后归零。
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
  }
});

test('hidden/resources-are-fully-independent', async () => {
  // 契约第 5 条：不同资源互不影响。
  const manager = new LockManager();
  const order: string[] = [];
  const releases: Release[] = [];
  // a 被占用并有等待者，b 完全空闲。
  const holdA = await manager.acquire('a');
  manager.acquire('a').then(release => { order.push('a2'); releases.push(release); });
  await Promise.resolve();
  // b 的请求必须立即被授予，不受 a 的队列影响。
  const holdB = await manager.acquire('b');
  assert.equal(manager.queueLength, 1, 'b 的请求被错误地排队了');
  // b 上再排一个，然后释放 b 的第一个持有者。
  manager.acquire('b').then(release => { order.push('b2'); releases.push(release); });
  await Promise.resolve();
  assert.equal(manager.queueLength, 2);
  holdB();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(order, ['b2'], '释放 b 没有唤醒 b2');
  // 释放 a 同样只影响 a。
  holdA();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(order, ['b2', 'a2'], 'a2 没有被授予');
  releases[0]!();
  await Promise.resolve();
  releases[1]!();
  await Promise.resolve();
  assert.equal(manager.queueLength, 0);
});

test('hidden/ten-waiters-are-served-in-order', async () => {
  // 压力：十个等待者必须严格按到达顺序被授予，且每次只授予一个。
  const manager = new LockManager();
  const order: number[] = [];
  const releases: Array<Release | undefined> = [];
  manager.acquire('r').then(release => { order.push(0); releases[0] = release; });
  await Promise.resolve();
  for (let index = 1; index <= 10; index += 1) {
    manager.acquire('r').then(release => { order.push(index); releases[index] = release; });
    await Promise.resolve();
  }
  assert.equal(manager.queueLength, 10, 'queueLength 不是 10');
  assert.deepEqual(order, [0], '初次授予后还有别的请求被授予');
  // 逐个释放：每次只推进一个，且推进的是队首。
  for (let step = 0; step < 10; step += 1) {
    const release = releases[step];
    assert.equal(typeof release, 'function', '第 ' + step + ' 个释放函数不存在');
    release!();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(order.length, step + 2, '第 ' + step + ' 次释放后授予数不对：' + order.length);
    assert.equal(order[step + 1], step + 1, '第 ' + step + ' 次授予的请求不是队首');
    assert.equal(manager.queueLength, 9 - step, '第 ' + step + ' 次释放后 queueLength 不对');
  }
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], '最终授予顺序不对');
  assert.equal(manager.queueLength, 0, '结束时队列未清空');
});
