import test from 'node:test';
import assert from 'node:assert/strict';
import { CommitError, Coordinator, type Layer, type Layers } from '../starter/src/consistency.ts';

function memoryLayer(name: string, options: { failOnApply?: boolean; failOnRevert?: boolean } = {}) {
  const values = new Set<string>();
  const events: string[] = [];
  const layer: Layer = {
    name,
    apply(value) {
      events.push('apply:' + value);
      if (options.failOnApply === true) throw new Error('apply 失败：' + name);
      values.add(value);
    },
    revert(value) {
      events.push('revert:' + value);
      if (options.failOnRevert === true) throw new Error('revert 失败：' + name);
      values.delete(value);
    },
    has(value) { return values.has(value); },
  };
  return { layer, events, values };
}

function build(failing: 'ui' | 'cache' | null = null) {
  const service = memoryLayer('service');
  const cache = memoryLayer('cache');
  const ui = memoryLayer('ui', failing === 'ui' ? { failOnApply: true } : {});
  const layers: Layers = { service: service.layer, cache: failing === 'cache' ? { ...cache.layer, apply(value) { cache.events.push('apply:' + value); throw new Error('apply 失败：cache'); } } : cache.layer, ui: ui.layer };
  return { layers, service, cache, ui };
}

test('hidden/commits-in-fixed-order', async () => {
  const { layers, service, cache, ui } = build();
  const coordinator = new Coordinator(layers);
  assert.equal(await coordinator.commit('v1'), 'v1');
  assert.deepEqual(service.events, ['apply:v1']);
  assert.deepEqual(cache.events, ['apply:v1']);
  assert.deepEqual(ui.events, ['apply:v1']);
  assert.deepEqual(coordinator.applied, ['v1']);
  assert.ok(service.layer.has('v1') && cache.layer.has('v1') && ui.layer.has('v1'));
});

test('hidden/rolls-back-every-applied-layer', async () => {
  const { layers, service, cache } = build('ui');
  const coordinator = new Coordinator(layers);
  await assert.rejects(async () => coordinator.commit('v2'), (error: unknown) => error instanceof CommitError && error.layer === 'ui');
  assert.deepEqual(service.events, ['apply:v2', 'revert:v2']);
  assert.deepEqual(cache.events, ['apply:v2', 'revert:v2']);
  assert.deepEqual(coordinator.applied, []);
});

test('hidden/layers-stay-consistent-after-failure', async () => {
  const { layers, service, cache, ui } = build('cache');
  const coordinator = new Coordinator(layers);
  await assert.rejects(async () => coordinator.commit('v3'));
  assert.equal(service.layer.has('v3'), false);
  assert.equal(cache.layer.has('v3'), false);
  assert.equal(ui.layer.has('v3'), false);
  assert.deepEqual(coordinator.applied, []);
});

test('hidden/reports-failing-layer-and-recovers', async () => {
  const { layers } = build('ui');
  const coordinator = new Coordinator(layers);
  await assert.rejects(async () => coordinator.commit('v4'), (error: unknown) => error instanceof CommitError && error.layer === 'ui');
  const healthy = build();
  const second = new Coordinator(healthy.layers);
  assert.equal(await second.commit('v4'), 'v4');
});

test('hidden/repeated-commit-is-idempotent', async () => {
  const { layers, service } = build();
  const coordinator = new Coordinator(layers);
  await coordinator.commit('v5');
  await coordinator.commit('v5');
  assert.deepEqual(service.events, ['apply:v5']);
  assert.deepEqual(coordinator.applied, ['v5']);
});

test('hidden/rollback-order-is-exact-reverse', () => {
  // 契约第 2 条：按**相反顺序**回滚已应用的层。
  // service、cache 成功，ui 失败：必须 cache 先回滚、service 后回滚。
  const trace: string[] = [];
  const make = (name: string, failApply: boolean): Layer => ({
    name,
    apply(value) { trace.push('apply:' + name); if (failApply) throw new Error('boom'); },
    revert(value) { trace.push('revert:' + name); },
    has(value) { return trace.includes('apply:' + name); },
  });
  const layers: Layers = { service: make('service', false), cache: make('cache', false), ui: make('ui', true) };
  return new Coordinator(layers).commit('x').catch(() => {
    assert.deepEqual(trace, [
      'apply:service', 'apply:cache', 'apply:ui',
      'revert:cache', 'revert:service',
    ], '回滚顺序不对：' + trace.join(','));
  });
});

test('hidden/never-reverts-a-layer-that-was-not-applied', async () => {
  // 契约第 5 条：只回滚本次已应用的层。
  // service 首个就失败：cache 与 ui 不得被 revert。
  const trace: string[] = [];
  const make = (name: string, failApply: boolean): Layer => ({
    name,
    apply() { trace.push('apply:' + name); if (failApply) throw new Error('boom'); },
    revert() { trace.push('revert:' + name); },
    has() { return false; },
  });
  const layers: Layers = { service: make('service', true), cache: make('cache', false), ui: make('ui', false) };
  await assert.rejects(async () => new Coordinator(layers).commit('y'), CommitError);
  assert.deepEqual(trace, ['apply:service'], '回滚了未应用的层：' + trace.join(','));
});

test('hidden/failure-at-first-layer-reports-that-layer', async () => {
  // 三层各自失败都必须报自己的层名。
  for (const [failing, expected] of [['service', 'service'], ['cache', 'cache'], ['ui', 'ui']] as const) {
    const trace: string[] = [];
    const make = (name: string): Layer => ({
      name,
      apply() { trace.push('apply:' + name); if (name === failing) throw new Error('boom'); },
      revert() { trace.push('revert:' + name); },
      has() { return false; },
    });
    const layers: Layers = { service: make('service'), cache: make('cache'), ui: make('ui') };
    await assert.rejects(
      async () => new Coordinator(layers).commit('z'),
      (error: unknown) => error instanceof CommitError && error.layer === expected,
      'failing=' + failing,
    );
    // 失败层之后的层不得被应用。
    const order = ['service', 'cache', 'ui'];
    const failedIndex = order.indexOf(failing);
    assert.equal(trace.filter(e => e.startsWith('apply:')).length, failedIndex + 1,
      'failing=' + failing + ' 时应用层数不对：' + trace.join(','));
  }
});

test('hidden/applied-records-every-successful-value-in-order', async () => {
  // 契约第 1 条：成功提交才记入 applied，按提交顺序。
  const { layers } = build();
  const coordinator = new Coordinator(layers);
  assert.deepEqual(coordinator.applied, []);
  await coordinator.commit('a');
  await coordinator.commit('b');
  await coordinator.commit('c');
  assert.deepEqual(coordinator.applied, ['a', 'b', 'c']);
  // applied 返回副本，外部改它不得影响内部状态。
  const snapshot = coordinator.applied;
  (snapshot as string[]).push('injected');
  assert.deepEqual(coordinator.applied, ['a', 'b', 'c'], 'applied 暴露了内部数组');
  // 重复提交既有值不重复记录。
  await coordinator.commit('b');
  assert.deepEqual(coordinator.applied, ['a', 'b', 'c']);
});

test('hidden/retry-after-failure-can-succeed', async () => {
  // 一次失败（已回滚）后，同一个值必须能重新提交成功。
  const trace: string[] = [];
  let failNext = true;
  const make = (name: string): Layer => ({
    name,
    apply(value) {
      trace.push('apply:' + name);
      if (name === 'ui' && failNext) { failNext = false; throw new Error('boom'); }
    },
    revert(value) { trace.push('revert:' + name); },
    has() { return false; },
  });
  const layers: Layers = { service: make('service'), cache: make('cache'), ui: make('ui') };
  const coordinator = new Coordinator(layers);
  await assert.rejects(async () => coordinator.commit('retry'), CommitError);
  assert.deepEqual(coordinator.applied, [], '失败后 applied 不应记录该值');
  // 第二次提交同一个值必须真的重新 apply（而不是被幂等逻辑跳过）。
  assert.equal(await coordinator.commit('retry'), 'retry');
  assert.deepEqual(coordinator.applied, ['retry']);
  assert.deepEqual(trace.filter(e => e === 'apply:ui'), ['apply:ui', 'apply:ui'], '重试没有重新应用 ui');
});

test('hidden/idempotent-check-does-not-disturb-other-values', () => {
  // 已提交的值重复提交不触碰层；已提交别的值时仍正常应用。
  const trace: string[] = [];
  const make = (name: string): Layer => ({
    name,
    apply(value) { trace.push('apply:' + name + ':' + value); },
    revert(value) { trace.push('revert:' + name + ':' + value); },
    has() { return true; },
  });
  const layers: Layers = { service: make('service'), cache: make('cache'), ui: make('ui') };
  const coordinator = new Coordinator(layers);
  return coordinator.commit('p')
    .then(() => coordinator.commit('p'))
    .then(() => {
      assert.deepEqual(trace, ['apply:service:p', 'apply:cache:p', 'apply:ui:p'], '重复提交触碰了层');
      return coordinator.commit('q');
    })
    .then(() => {
      assert.equal(trace.filter(e => e.endsWith(':q')).length, 3, '新值没有应用到三层');
    });
});
