import test from 'node:test';
import assert from 'node:assert/strict';
import { PluginHost, SwitchError, type Plugin } from '../starter/src/plugins.ts';

function plugin(id: string, options: { failOnSetup?: boolean } = {}) {
  const events: string[] = [];
  const instance: Plugin = {
    id,
    setup() {
      events.push('setup:' + id);
      if (options.failOnSetup === true) throw new Error('setup 失败：' + id);
    },
    teardown() { events.push('teardown:' + id); },
  };
  return { instance, events };
}

test('hidden/switch-succeeds-and-releases-previous', async () => {
  const first = plugin('alpha');
  const second = plugin('beta');
  const host = new PluginHost(first.instance);
  await host.switchTo(second.instance);
  assert.equal(host.active, 'beta');
  assert.deepEqual(first.events, ['setup:alpha', 'teardown:alpha']);
  assert.deepEqual(second.events, ['setup:beta']);
  assert.deepEqual(host.released, ['alpha']);
});

test('hidden/failed-switch-keeps-previous-plugin', async () => {
  const first = plugin('alpha');
  const broken = plugin('broken', { failOnSetup: true });
  const host = new PluginHost(first.instance);
  await assert.rejects(async () => host.switchTo(broken.instance), SwitchError);
  assert.equal(host.active, 'alpha', '切换失败后旧插件必须仍然生效');
  assert.deepEqual(first.events, ['setup:alpha'], '旧插件不得被 teardown');
});

test('hidden/failed-switch-releases-new-plugin', async () => {
  const first = plugin('alpha');
  const broken = plugin('broken', { failOnSetup: true });
  const host = new PluginHost(first.instance);
  await assert.rejects(async () => host.switchTo(broken.instance), SwitchError);
  assert.deepEqual(broken.events, ['setup:broken', 'teardown:broken'], '新插件占用的资源必须被释放');
  assert.deepEqual(host.released, ['broken']);
});

test('hidden/teardown-happens-once-per-plugin', async () => {
  const first = plugin('alpha');
  const second = plugin('beta');
  const host = new PluginHost(first.instance);
  await host.switchTo(second.instance);
  await host.switchTo(second.instance);
  await host.switchTo(first.instance);
  assert.deepEqual(host.released, ['alpha', 'beta']);
  assert.equal(second.events.filter(event => event === 'teardown:beta').length, 1);
  assert.equal(host.active, 'alpha');
});

test('hidden/switch-to-same-plugin-is-noop', async () => {
  const first = plugin('alpha');
  const host = new PluginHost(first.instance);
  await host.switchTo(first.instance);
  assert.deepEqual(first.events, ['setup:alpha']);
  assert.deepEqual(host.released, []);
});
