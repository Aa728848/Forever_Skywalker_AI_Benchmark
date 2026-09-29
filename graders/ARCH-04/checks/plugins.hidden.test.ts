import test from 'node:test';
import assert from 'node:assert/strict';
import { PluginHost, SwitchError, type Plugin } from '../starter/src/plugins.ts';

interface Trace extends Plugin {
  readonly log: string[];
}

/** 记录 setup/teardown 调用顺序的插件工厂。 */
function tracked(id: string, options: { failSetup?: boolean; failTeardown?: boolean; log: string[] } = {}): Trace {
  const log = options.log ?? [];
  return {
    id,
    log,
    setup() {
      log.push('setup:' + id);
      if (options.failSetup === true) throw new Error('setup 失败：' + id);
    },
    teardown() {
      log.push('teardown:' + id);
      if (options.failTeardown === true) throw new Error('teardown 失败：' + id);
    },
  };
}

test('hidden/success-order-is-setup-then-commit-then-teardown', async () => {
  // 契约第 1 条：先 setup 新插件，成功后换 active 并 teardown 旧插件。
  const log: string[] = [];
  const initial = tracked('a', { log });
  const host = new PluginHost(initial);
  assert.deepEqual(log, ['setup:a'], '构造时没有 setup 初始插件');
  assert.equal(host.active, 'a');
  assert.deepEqual([...host.released], []);

  const next = tracked('b', { log });
  await host.switchTo(next);
  assert.deepEqual(log, ['setup:a', 'setup:b', 'teardown:a'], '切换顺序不对：' + log.join(','));
  assert.equal(host.active, 'b');
  assert.deepEqual([...host.released], ['a']);
});

test('hidden/failed-setup-rolls-back-new-and-keeps-old', async () => {
  // 契约第 2 条：新插件 setup 抛错时必须 teardown 新插件并记入 released；
  // 旧插件保持生效且**不得**被 teardown。
  const log: string[] = [];
  const initial = tracked('a', { log });
  const host = new PluginHost(initial);
  const failing = tracked('b', { log, failSetup: true });

  const error = new Error('启动炸了');
  failing.setup = () => { log.push('setup:b'); throw error; };

  await assert.rejects(async () => host.switchTo(failing),
    (thrown: unknown) => thrown instanceof SwitchError && thrown.from === 'a' && thrown.to === 'b',
    '没有以 SwitchError 拒绝或 from/to 不对');
  // 新插件被 teardown（回收它占用的资源）并记入 released。
  assert.equal(log.includes('teardown:b'), true, '失败的新插件没有被 teardown：' + log.join(','));
  assert.deepEqual([...host.released], ['b'], 'released 记录不对：' + JSON.stringify([...host.released]));
  // 旧插件仍生效，未被 teardown。
  assert.equal(host.active, 'a', 'active 变了');
  assert.equal(log.includes('teardown:a'), false, '旧插件被 teardown 了');
  // 旧插件仍可用：切到别的插件时它才退出。
  const third = tracked('c', { log });
  await host.switchTo(third);
  assert.deepEqual(log, ['setup:a', 'setup:b', 'teardown:b', 'setup:c', 'teardown:a'], log.join(','));
  assert.equal(host.active, 'c');
});

test('hidden/each-plugin-is-torn-down-at-most-once', async () => {
  // 契约第 3 条：每个插件最多被 teardown 一次。
  const log: string[] = [];
  const host = new PluginHost(tracked('a', { log }));
  const b = tracked('b', { log });
  const c = tracked('c', { log });
  await host.switchTo(b);
  await host.switchTo(c);
  // 重复切换到已释放的插件不会二次 teardown。
  assert.deepEqual(log, ['setup:a', 'setup:b', 'teardown:a', 'setup:c', 'teardown:b'], log.join(','));
  // 每个 id 恰好出现一次 teardown。
  const teardowns = log.filter(entry => entry.startsWith('teardown:'));
  assert.equal(new Set(teardowns).size, teardowns.length, '存在重复 teardown：' + teardowns.join(','));
  assert.deepEqual([...host.released], ['a', 'b'], 'released 顺序或内容不对');
  // 失败的切换：同一个插件实例被 teardown 恰好一次。
  const d = tracked('d', { log, failSetup: true });
  await assert.rejects(async () => host.switchTo(d), SwitchError);
  const dTeardowns = log.filter(entry => entry === 'teardown:d');
  assert.equal(dTeardowns.length, 1, '失败的 d 被 teardown 了 ' + dTeardowns.length + ' 次');
  // 整个流程（含失败候选）里每个 id 最多一次 teardown。
  const allTeardowns = log.filter(entry => entry.startsWith('teardown:'));
  assert.equal(new Set(allTeardowns).size, allTeardowns.length, '存在重复 teardown：' + allTeardowns.join(','));
});

test('hidden/switch-to-same-id-is-a-complete-noop', async () => {
  // 契约第 4 条：切换到相同 id 是空操作——不 setup、不 teardown、released 不变。
  const log: string[] = [];
  const host = new PluginHost(tracked('a', { log }));
  const before = [...host.released];
  // 同 id 但不同实例：仍然必须是空操作。
  await host.switchTo(tracked('a', { log }));
  assert.deepEqual(log, ['setup:a'], '同 id 切换触发了调用：' + log.join(','));
  assert.deepEqual([...host.released], before, '同 id 切换改了 released');
  assert.equal(host.active, 'a');
  // 连续多次同 id 切换仍是空操作。
  await host.switchTo(tracked('a', { log }));
  await host.switchTo(tracked('a', { log }));
  assert.deepEqual(log, ['setup:a'], '重复同 id 切换触发了调用');
  // 切走再切回：这次是真的切换（id 与当前 active 不同）。
  await host.switchTo(tracked('b', { log }));
  assert.equal(host.active, 'b');
  assert.deepEqual(log, ['setup:a', 'setup:b', 'teardown:a'], log.join(','));
  await host.switchTo(tracked('a', { log }));
  assert.deepEqual(log, ['setup:a', 'setup:b', 'teardown:a', 'setup:a', 'teardown:b'], log.join(','));
  assert.deepEqual([...host.released], ['a', 'b']);
});

test('hidden/released-is-snapshot-and-rollback-then-retry-succeeds', async () => {
  // released 返回副本；失败切换后可以重试成功。
  const log: string[] = [];
  const host = new PluginHost(tracked('a', { log }));
  const failing = tracked('b', { log });
  failing.setup = () => { log.push('setup:b'); throw new Error('先失败'); };
  await assert.rejects(async () => host.switchTo(failing), SwitchError);
  // 取出快照后外部改写不得污染内部记录。
  const snapshot = host.released;
  (snapshot as string[]).push('injected');
  assert.deepEqual([...host.released], ['b'], 'released 暴露了内部数组');
  // 同一个 b 再次尝试（这次 setup 正常）应成功。
  const retry = tracked('b', { log });
  await host.switchTo(retry);
  assert.equal(host.active, 'b');
  assert.deepEqual(log, ['setup:a', 'setup:b', 'teardown:b', 'setup:b', 'teardown:a'], log.join(','));
  // released 累计两条（第一次的 b 与后来的 a）。
  assert.deepEqual([...host.released], ['b', 'a'], 'released 累计不对：' + JSON.stringify([...host.released]));
});
