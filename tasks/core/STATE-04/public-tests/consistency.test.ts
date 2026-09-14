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

test('public/commits-in-fixed-order', async () => {
  const { layers, service, cache, ui } = build();
  const coordinator = new Coordinator(layers);
  assert.equal(await coordinator.commit('v1'), 'v1');
  assert.deepEqual(service.events, ['apply:v1']);
  assert.deepEqual(cache.events, ['apply:v1']);
  assert.deepEqual(ui.events, ['apply:v1']);
  assert.deepEqual(coordinator.applied, ['v1']);
  assert.ok(service.layer.has('v1') && cache.layer.has('v1') && ui.layer.has('v1'));
});

test('public/rolls-back-every-applied-layer', async () => {
  const { layers, service, cache } = build('ui');
  const coordinator = new Coordinator(layers);
  await assert.rejects(async () => coordinator.commit('v2'), (error: unknown) => error instanceof CommitError && error.layer === 'ui');
  assert.deepEqual(service.events, ['apply:v2', 'revert:v2']);
  assert.deepEqual(cache.events, ['apply:v2', 'revert:v2']);
  assert.deepEqual(coordinator.applied, []);
});

test('public/layers-stay-consistent-after-failure', async () => {
  const { layers, service, cache, ui } = build('cache');
  const coordinator = new Coordinator(layers);
  await assert.rejects(async () => coordinator.commit('v3'));
  assert.equal(service.layer.has('v3'), false);
  assert.equal(cache.layer.has('v3'), false);
  assert.equal(ui.layer.has('v3'), false);
  assert.deepEqual(coordinator.applied, []);
});

test('public/reports-failing-layer-and-recovers', async () => {
  const { layers } = build('ui');
  const coordinator = new Coordinator(layers);
  await assert.rejects(async () => coordinator.commit('v4'), (error: unknown) => error instanceof CommitError && error.layer === 'ui');
  const healthy = build();
  const second = new Coordinator(healthy.layers);
  assert.equal(await second.commit('v4'), 'v4');
});

test('public/repeated-commit-is-idempotent', async () => {
  const { layers, service } = build();
  const coordinator = new Coordinator(layers);
  await coordinator.commit('v5');
  await coordinator.commit('v5');
  assert.deepEqual(service.events, ['apply:v5']);
  assert.deepEqual(coordinator.applied, ['v5']);
});
