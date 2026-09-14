import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture, manifest, installPackage, removePackage, reconcile, settle, aggregatePatch, backupExists,
  mountOnce, makeGatewayRoutes, createPluginManagerFace, SshEngine, HostStore, makeRoutes, serve, syntheticHost } from './support.mjs';

test('public/reinstall-mounts-once-and-uninstall-releases-ownership', () => {
  const disposers = []; const ctx = { effect: setup => { disposers.push(setup()); } }; let mounted = 0;
  const apply = mountOnce('integration-public-plugin', () => { mounted += 1; });
  try { apply(ctx); apply(ctx); assert.equal(mounted, 1); disposers.splice(0).forEach(dispose => dispose()); apply(ctx); assert.equal(mounted, 2); }
  finally { disposers.splice(0).forEach(dispose => dispose()); }
});
test('public/gateway-preserves-single-mount-composition', async () => {
  const f = fixture({ 'dsh-aggregate': { patch: aggregatePatch }, 'dsh-existing': {} }, ['dsh-aggregate']);
  const gateway = f.gateway(args => { if (args[3] === 'add') { installPackage(f.profileDir, args[4]); reconcile(f.profileDir); } return { code: 0 }; });
  try {
    const job = await settle(gateway, gateway.install('dsh-new').jobId);
    assert.equal(job.phase, 'done');
    assert.deepEqual(manifest(f.profileDir).dsh.profile.bundles, ['dsh-aggregate', 'dsh-new']);
    assert.equal(backupExists(f), true, '保护写回必须保留原manifest备份');
  } finally { f.cleanup(); }
});
test('public/failed-install-clears-real-client-progress-and-can-retry', async () => {
  const f = fixture(); let failBoot = true; let changes = 0;
  const gateway = f.gateway(args => {
    if (args[3] === 'add') installPackage(f.profileDir, args[4]);
    if (args[3] === 'remove') removePackage(f.profileDir, args[4]);
    return args.includes('--dump-config') && failBoot ? { code: 1, output: 'dsh-demo boot failed' } : { code: 0 };
  });
  const server = await serve(makeGatewayRoutes({ facts: f.facts, gateway, cliAvailable: () => true, officialChannels: async () => false,
    dshVersion: async () => '1.0.0', fetchManifest: async () => ({ version: '1.0.0' }) }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => originalFetch(new URL(input, server.base), init);
  try {
    const face = createPluginManagerFace({ get: () => ({ isLoopback: true, rpc: { call: async () => { throw new Error('unexpected official channel'); } } }) });
    const unsubscribe = face.onChange(() => { changes += 1; });
    await assert.rejects(face.install('dsh-demo'), /启动预检失败|boot failed/);
    assert.equal((await face.status()).kind, 'idle'); assert.equal(changes, 0);
    assert.equal(manifest(f.profileDir).dependencies['dsh-demo'], undefined, '失败安装须完成实际文件回滚');
    failBoot = false; assert.equal((await face.install('dsh-demo')).id, 'dsh-demo');
    assert.equal((await face.status()).kind, 'idle'); assert.equal(changes, 1);
    assert.deepEqual(await face.uninstall('dsh-demo'), []); assert.equal(changes, 2); unsubscribe();
  } finally { globalThis.fetch = originalFetch; await server.close(); f.cleanup(); }
});
test('public/config-patch-invalidates-real-pool-and-tunnel', async () => {
  const f = fixture(); const store = new HostStore(join(f.directory, 'ssh.json')); store.create(syntheticHost());
  const engine = new SshEngine(store);
  const server = await serve(makeRoutes({ store, engine, stagingDir: join(f.directory, 'staging') }).routes);
  try {
    const info = await engine.startTunnel('local-test', { remotePort: 8080 });
    const tunnel = engine.tunnels.get(info.id); const oldClient = tunnel.record.client;
    assert.equal(tunnel.server.listening, true);
    const response = await fetch(server.base + '/api/dsh-ssh/hosts?alias=local-test', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: 'new-synthetic.invalid' }) });
    assert.equal(response.status, 200); assert.equal(store.find('local-test').host, 'new-synthetic.invalid');
    assert.equal(engine.tunnels.size, 0); assert.equal(engine.pool.size, 0);
    assert.equal(tunnel.server.listening, false); assert.equal(oldClient.ended, true);
  } finally { engine.dispose(); await server.close(); f.cleanup(); }
});
test('public/invalid-cli-input-never-starts-a-process', async () => {
  const f = fixture(); const gateway = f.gateway(() => { throw new Error('unsafe input reached transport'); });
  try { assert.equal((await settle(gateway, gateway.install('dsh-demo & echo forbidden').jobId)).phase, 'error'); assert.equal(f.calls.length, 0); }
  finally { f.cleanup(); }
});
test('public/remove-success-must-really-change-manifest', async () => {
  const f = fixture({ 'dsh-existing': {} }); const gateway = f.gateway(() => ({ code: 0 }));
  try { const job = await settle(gateway, gateway.remove('dsh-existing').jobId); assert.equal(job.phase, 'error'); assert.match(job.error, /卸载未生效/); }
  finally { f.cleanup(); }
});
