import { registerHooks } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
export { Client } from './transport.mjs';

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'yaml') return { shortCircuit: true, url: new URL('../starter/vendor/yaml/dist/index.js', import.meta.url).href };
  if (['ssh2', 'ws', './PluginManagerTab.tsx'].includes(specifier)) return { shortCircuit: true, url: new URL('./transport.mjs', import.meta.url).href };
  return next(specifier, context);
} });
const upstream = file => import(new URL('../starter/upstream/packages/' + file, import.meta.url));
export const { CliGateway, unsafeSpecReason } = await upstream('dsh-plugin-manager/src/host/gateway.ts');
export const { makeGatewayRoutes } = await upstream('dsh-plugin-manager/src/host/routes.ts');
export const { createPluginManagerFace } = await upstream('dsh-plugin-manager/src/client/index.ts');
export const { mountOnce } = await upstream('dsh-plugin-manager/src/mount-once.ts');
export const { SshEngine } = await upstream('dsh-ssh/src/engine.ts');
export const { HostStore } = await upstream('dsh-ssh/src/store.ts');
export const { makeRoutes } = await upstream('dsh-ssh/src/routes.ts');
export const { acquire } = await upstream('dsh-ssh/src/engine/connection-pool.ts');
export function writeManifest(profileDir, dependencies, bundles) {
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'synthetic-profile', private: true, dependencies, dsh: { profile: { bundles } } }));
}
export function manifest(profileDir) { return JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')); }
export function installPackage(profileDir, name, { version = '1.0.0', bundle = true, patch } = {}) {
  const directory = join(profileDir, 'node_modules', ...name.split('/')); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version, ...(bundle ? { dsh: { bundle: { patch: './cordis.patch.yml' } } } : {}) }));
  if (patch !== undefined) writeFileSync(join(directory, 'cordis.patch.yml'), patch);
  const value = manifest(profileDir); if (value.dependencies[name] === undefined) { value.dependencies[name] = '1.0.0'; value.dsh.profile.bundles.push(name); }
  writeManifest(profileDir, value.dependencies, value.dsh.profile.bundles);
}
export function reconcile(profileDir) {
  const value = manifest(profileDir);
  const bundles = Object.keys(value.dependencies).filter(name => JSON.parse(readFileSync(join(profileDir, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')).dsh?.bundle !== undefined);
  writeManifest(profileDir, value.dependencies, bundles);
}
export function removePackage(profileDir, name) {
  const value = manifest(profileDir); delete value.dependencies[name]; writeManifest(profileDir, value.dependencies, value.dsh.profile.bundles.filter(id => id !== name));
}
export function fixture(dependencies = {}, bundles = Object.keys(dependencies)) {
  const directory = mkdtempSync(join(tmpdir(), 'fsa-int-web-')), profileDir = join(directory, 'profiles', 'web');
  mkdirSync(profileDir, { recursive: true }); writeManifest(profileDir, Object.fromEntries(Object.keys(dependencies).map(name => [name, '1.0.0'])), bundles);
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '# original profile comment\n[]\n');
  for (const [name, options] of Object.entries(dependencies)) installPackage(profileDir, name, options);
  const facts = { profileName: 'web', profileDir, patchPath: join(profileDir, 'cordis.patch.yml'), packageJsonPath: join(profileDir, 'package.json') };
  const calls = [];
  const gateway = behavior => new CliGateway(facts, {}, {
    findBinary: () => '/synthetic/dsh',
    spawnImpl: (_binary, args) => {
      calls.push([...args]); const result = behavior(args) ?? { code: 0 };
      return { stdout: { on: (event, handler) => { if (event === 'data' && result.output) handler(Buffer.from(result.output)); } },
        stderr: { on() {} }, kill() {}, on: (event, handler) => { if (event === 'close') setImmediate(() => handler(result.code)); } };
    },
  });
  return { directory, profileDir, facts, calls, gateway, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
export async function settle(gateway, jobId) {
  for (let index = 0; index < 400; index += 1) { const job = gateway.status(jobId); if (job && job.phase !== 'running') return job; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('job did not settle within the upstream 2-second polling budget');
}
export const aggregatePatch = '- insert:\n    - id: existing-entry\n      name: dsh-existing\n';
export async function serve(routes) {
  const server = createServer((req, res) => {
    const route = routes.find(item => item.path === new URL(req.url, 'http://localhost').pathname);
    if (route === undefined) { res.writeHead(404); res.end(); return; }
    Promise.resolve(route.handler(req, res)).catch(error => { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  return { base, close: () => new Promise((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}
export function syntheticHost() { return { alias: 'local-test', host: 'synthetic.invalid', user: 'test-user', auth: { kind: 'password', password: 'synthetic-only' } }; }
export function backupExists(f) { return existsSync(join(f.profileDir, 'package.json.bak-plugin-manager')); }
