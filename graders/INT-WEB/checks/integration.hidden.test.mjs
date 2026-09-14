import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fixture, manifest, installPackage, removePackage, reconcile, settle, aggregatePatch, mountOnce,
  makeGatewayRoutes, createPluginManagerFace, SshEngine, HostStore, makeRoutes, serve, syntheticHost, acquire } from '../public-tests/support.mjs';

test('hidden/repeated-module-apply-keeps-one-registration', () => {
  let registrations = 0; const cleanup = [];
  const context = { effect: setup => { cleanup.push(setup()); } };
  try {
    mountOnce('integration-hidden-plugin', () => { registrations += 1; })(context);
    mountOnce('integration-hidden-plugin', () => { registrations += 1; })(context);
    assert.equal(registrations, 1);
  } finally { cleanup.forEach(dispose => dispose()); }
});
test('hidden/reconciliation-preserves-existing-dependency-and-comments', async () => {
  const f = fixture({ 'dsh-aggregate': { patch: aggregatePatch }, 'dsh-existing': {} }, ['dsh-aggregate']);
  const gateway = f.gateway(args => { if (args[3] === 'add') { installPackage(f.profileDir, args[4]); reconcile(f.profileDir); } return { code: 0 }; });
  try {
    await settle(gateway, gateway.install('dsh-new-one').jobId);
    await settle(gateway, gateway.install('dsh-new-two').jobId);
    assert.equal(manifest(f.profileDir).dependencies['dsh-existing'], '1.0.0');
    assert.equal(manifest(f.profileDir).dsh.profile.bundles.includes('dsh-existing'), false);
    assert.match(readFileSync(f.facts.patchPath, 'utf8'), /original profile comment/);
  } finally { f.cleanup(); }
});
test('hidden/sibling-tunnels-close-on-alias-deletion-and-new-config-reconnects', async () => {
  const f = fixture(); const store = new HostStore(join(f.directory, 'ssh.json')); store.create(syntheticHost()); const engine = new SshEngine(store);
  const server = await serve(makeRoutes({ store, engine, stagingDir: join(f.directory, 'staging') }).routes);
  try {
    const first = await engine.startTunnel('local-test', { remotePort: 9001 });
    await engine.startTunnel('local-test', { remotePort: 9002 });
    const servers = [...engine.tunnels.values()].map(item => item.server); const old = engine.tunnels.get(first.id).record.client;
    const response = await fetch(server.base + '/api/dsh-ssh/hosts?alias=local-test', { method: 'DELETE' });
    assert.equal(response.status, 200); assert.equal(engine.tunnels.size, 0); assert.equal(old.ended, true);
    assert.ok(servers.every(server => !server.listening));
    store.create({ ...syntheticHost(), host: 'replacement.invalid' });
    const fresh = await acquire(engine, 'local-test'); assert.notEqual(fresh.client, old); assert.equal(fresh.client.config.host, 'replacement.invalid');
  } finally { engine.dispose(); await server.close(); f.cleanup(); }
});
test('hidden/client-http-error-does-not-leave-progress-stuck', async () => {
  const f = fixture(); const gateway = f.gateway(() => ({ code: 0 }));
  const server = await serve(makeGatewayRoutes({ facts: f.facts, gateway, cliAvailable: () => false, officialChannels: async () => false }));
  const originalFetch = globalThis.fetch; globalThis.fetch = (input, init) => originalFetch(new URL(input, server.base), init);
  try {
    const face = createPluginManagerFace({ get: () => ({ isLoopback: true, rpc: { call: async () => ({ ok: false }) } }) });
    await assert.rejects(face.install('dsh-demo'), /CLI/); assert.equal((await face.status()).kind, 'idle');
  } finally { globalThis.fetch = originalFetch; await server.close(); f.cleanup(); }
});
test('hidden/invalid-host-patch-preserves-live-config-and-connection', async () => {
  const f = fixture(); const store = new HostStore(join(f.directory, 'ssh.json')); store.create(syntheticHost()); const engine = new SshEngine(store);
  const server = await serve(makeRoutes({ store, engine, stagingDir: join(f.directory, 'staging') }).routes);
  try {
    const original = await acquire(engine, 'local-test');
    const response = await fetch(server.base + '/api/dsh-ssh/hosts?alias=local-test', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port: 70000 }) });
    assert.equal(response.status, 400); assert.equal(store.find('local-test').port, 22); assert.equal(engine.pool.get('local-test'), original);
  } finally { engine.dispose(); await server.close(); f.cleanup(); }
});
test('hidden/finished-job-retention-is-bounded', async () => {
  const f = fixture(); const gateway = f.gateway(() => ({ code: 1, output: 'synthetic failure' }));
  try {
    let oldest; let latest;
    for (let index = 0; index < 105; index += 1) { latest = gateway.install('dsh-repeated').jobId; oldest ??= latest; await settle(gateway, latest); }
    assert.equal(gateway.status(oldest), undefined); assert.equal(gateway.status(latest).phase, 'error');
  } finally { f.cleanup(); }
});


test('hidden/dropping-one-alias-preserves-unrelated-live-tunnels', async () => {
  const f = fixture(); const store = new HostStore(join(f.directory, 'ssh.json'));
  store.create(syntheticHost()); store.create({ ...syntheticHost(), alias: 'other-alias', host: 'other-synthetic.invalid' });
  const engine = new SshEngine(store);
  const server = await serve(makeRoutes({ store, engine, stagingDir: join(f.directory, 'staging') }).routes);
  try {
    const target = await engine.startTunnel('local-test', { remotePort: 9001 });
    const sibling = await engine.startTunnel('local-test', { remotePort: 9002 });
    const unrelated = await engine.startTunnel('other-alias', { remotePort: 9010 });
    const targetServers = [engine.tunnels.get(target.id).server, engine.tunnels.get(sibling.id).server];
    const other = engine.tunnels.get(unrelated.id); const otherRecord = other.record;
    const response = await fetch(server.base + '/api/dsh-ssh/hosts?alias=local-test', { method: 'DELETE' });
    assert.equal(response.status, 200);
    assert.ok(targetServers.every(listener => !listener.listening));
    assert.deepEqual([...engine.tunnels.keys()], [unrelated.id]);
    assert.equal(other.server.listening, true); assert.equal(otherRecord.client.ended, false);
    assert.equal(engine.pool.get('other-alias'), otherRecord);
    const continued = await engine.startTunnel('other-alias', { remotePort: 9011 });
    assert.equal(engine.tunnels.get(continued.id).record, otherRecord);
  } finally { engine.dispose(); await server.close(); f.cleanup(); }
});
