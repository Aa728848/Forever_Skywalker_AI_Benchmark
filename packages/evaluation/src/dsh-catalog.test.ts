import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { discoverDshModels, profilePluginSpecifiers } from './dsh-catalog.ts';

let scratch: string;
let dshRoot: string;
let dshHome: string;

function write(path: string, value: string) {
  const target = join(dshRoot, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, value);
}

function writeProfile(name: string, bundles: string[]) {
  const target = join(dshHome, 'profiles', name, 'package.json');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify({ name: `dsh-profile-${name}`, private: true, dsh: { profile: { bundles } } }));
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'fsa-catalog-test-')); dshRoot = join(scratch, 'dsh'); dshHome = join(scratch, 'home'); mkdirSync(dshHome);
  write('package.json', JSON.stringify({ type: 'module' }));
  write('packages/sdk/client/package.json', JSON.stringify({ name: '@deepseek-ai/dsh-sdk-client', version: '0.1.5' }));
  write('apps/cli/package.json', JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5' }));
  write('packages/sdk/client/lib/index.js', 'throw new Error("SDK must not start");');
  write('apps/cli/lib/bin.js', 'throw new Error("CLI must not start");');
  write('packages/settings/settings-file/node_modules/@deepseek-ai/cordis/package.json', JSON.stringify({ type: 'module', exports: './index.js' }));
  write('packages/settings/settings-file/node_modules/@deepseek-ai/cordis/index.js', `export class Context {
    fiber={dispose:async()=>{}};
    services={};
    provide(name,value){this.services[name]=value;}
    get(name){return this.services[name];}
    async plugin(plugin,config){if(typeof plugin==='function')new plugin(this,config);else await plugin.apply(this,config);}
  }`);
  write('packages/settings/settings-file/lib/index.js', `import {readFileSync} from 'node:fs';
    export class FileSettingsProvider {constructor(ctx,config){if(config.watch!==false)throw new Error('watch must be disabled');ctx.settings=JSON.parse(readFileSync(config.path,'utf8'));}}
  `);
  write('packages/llm/llm/lib/index.js', `export class LlmRuntime {
    constructor(ctx){this.ctx=ctx;ctx.llm=this;ctx.llmRuntime=this;this.extra=[];}
    listProviders(){return [...this.ctx.settings.providers,...this.extra];}
    async listModels(provider){return this.listProviders().find(item=>item.id===provider).models;}
    async resolveModelInfo(provider,id){const model=(await this.listModels(provider)).find(item=>item.id===id);return model.reasoningEfforts?{reasoning:{efforts:model.reasoningEfforts.map(id=>({id}))}}:{};}
  }`);
  write('packages/llm/llm-deepseek/lib/index.js', 'export function apply(){}');
  write('packages/llm/llm-pi-ai/lib/index.js', `import {readFileSync,writeFileSync} from 'node:fs';
    export async function apply(ctx){
      const settings=ctx.settings;
      if(settings.action==='read-credentials')readFileSync(settings.target,'utf8');
      if(settings.action==='write')writeFileSync(settings.target,'changed');
      if(settings.action==='network')await fetch(settings.target);
      if(settings.action==='error')throw new Error(settings.secret);
      if(settings.action==='hang')await new Promise(()=>setInterval(()=>{},1000));
    }
  `);
  writeProfile('sdk', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app']);
});

afterEach(() => {
  const target = resolve(scratch);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('fsa-catalog-test-')) throw new Error('测试清理越界。');
  rmSync(target, { recursive: true, force: true });
});

it('读取公开本地目录且保持同名模型的provider身份，仅返回已声明思考等级与白名单', async () => {
  writeFileSync(join(dshHome, 'settings.yaml'), JSON.stringify({ secret: 'private-test-value', providers: [
    { id: 'gateway-a', name: 'A', apiKey: 'private-test-value', models: [{ id: 'same-model', name: 'Plain', token: 'private-test-value' }] },
    { id: 'gateway-b', name: 'B', models: [{ id: 'same-model', name: 'Reasoner', reasoningEfforts: ['off', 'high'] }] },
  ] }));
  const result = await discoverDshModels({ dshRoot, dshHome, profile: 'sdk' });
  expect(result.providers).toEqual([
    { id: 'gateway-a', name: 'A', models: [{ id: 'same-model', name: 'Plain', reasoningEfforts: [] }] },
    { id: 'gateway-b', name: 'B', models: [{ id: 'same-model', name: 'Reasoner', reasoningEfforts: ['off', 'high'] }] },
  ]);
  expect(result.warning).toContain('订阅渠道');
  expect(JSON.stringify(result)).not.toContain('private-test-value');
});

it('把当前 profile 已安装的本地插件路由并入目录，并只读取包入口', async () => {
  writeFileSync(join(dshHome, 'settings.yaml'), JSON.stringify({ providers: [] }));
  writeProfile('web', ['@deepseek-ai/dsh-base', 'subscription-channel']);
  const plugin = join(dshHome, 'profiles', 'web', 'node_modules', 'subscription-channel');
  mkdirSync(join(plugin, 'lib'), { recursive: true });
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: 'subscription-channel', version: '1.0.0', exports: { '.': { types: './lib/index.d.ts', default: './lib/index.js' } } }));
  writeFileSync(join(plugin, 'lib', 'index.js'), `export async function apply(ctx) {
    await ctx.llmRuntime.extra.push({ id: 'subscription', name: 'Subscription', models: [{ id: 'sub-model', name: 'Sub', reasoningEfforts: ['low', 'high'] }] });
  }`);

  const specs = profilePluginSpecifiers(dshRoot, dshHome, 'web');
  expect(specs.plugins).toEqual([{ id: 'subscription-channel', specifier: pathToFileURL(join(plugin, 'lib', 'index.js')).href }]);
  const result = await discoverDshModels({ dshRoot, dshHome, profile: 'web' });
  expect(result.providers).toEqual([{ id: 'subscription', name: 'Subscription', models: [{ id: 'sub-model', name: 'Sub', reasoningEfforts: ['low', 'high'] }] }]);
});

it('插件装载失败只提示该插件并保留其它目录与手工输入', async () => {
  writeFileSync(join(dshHome, 'settings.yaml'), JSON.stringify({ providers: [
    { id: 'gateway-a', name: 'A', models: [{ id: 'plain', name: 'Plain' }] },
  ] }));
  writeProfile('web', ['@deepseek-ai/dsh-base', 'broken-channel']);
  const plugin = join(dshHome, 'profiles', 'web', 'node_modules', 'broken-channel');
  mkdirSync(join(plugin, 'lib'), { recursive: true });
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: 'broken-channel', version: '1.0.0', main: 'lib/index.js' }));
  writeFileSync(join(plugin, 'lib', 'index.js'), 'throw new Error("private-test-value: channel unavailable");');
  const result = await discoverDshModels({ dshRoot, dshHome, profile: 'web' });
  expect(result.providers.map(provider => provider.id)).toEqual(['gateway-a']);
  expect(result.warning).toContain('broken-channel');
  expect(result.warning).not.toContain('private-test-value');
});

it('已初始化但没有任何本地插件的 profile 仍返回原生目录', async () => {
  writeFileSync(join(dshHome, 'settings.yaml'), JSON.stringify({ providers: [
    { id: 'gateway-a', name: 'A', models: [{ id: 'plain', name: 'Plain' }] },
  ] }));
  const result = await discoverDshModels({ dshRoot, dshHome, profile: 'sdk' });
  expect(result.providers.map(provider => provider.id)).toEqual(['gateway-a']);
});

it.each(['read-credentials', 'write', 'error'])('目录模块尝试%s时拒绝操作并只返回手工输入提示', async action => {
  const target = join(dshHome, '.credentials.yaml'); writeFileSync(target, 'private-test-value');
  writeFileSync(join(dshHome, 'settings.yaml'), JSON.stringify({ providers: [], action, target, secret: 'private-test-value' }));
  const result = await discoverDshModels({ dshRoot, dshHome });
  expect(result.providers).toEqual([]); expect(result.warning).toContain('手工填写');
  expect(JSON.stringify(result)).not.toContain('private-test-value');
  expect(readFileSync(target, 'utf8')).toBe('private-test-value');
});

it('只读目录查询不向供应商发送网络探测', async () => {
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end('{}'); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  try {
    const address = server.address(); if (typeof address !== 'object' || address === null) throw new Error('missing test server');
    writeFileSync(join(dshHome, 'settings.yaml'), JSON.stringify({ providers: [], action: 'network', target: `http://127.0.0.1:${address.port}/models` }));
    const result = await discoverDshModels({ dshRoot, dshHome });
    expect(result.providers).toEqual([]); expect(requests).toBe(0); expect(result.warning).toContain('手工填写');
  } finally {
    server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  }
});

it('插件按 DSH home 物化凭据时只落在本次查询的临时目录', async () => {
  writeFileSync(join(dshHome, 'settings.yaml'), JSON.stringify({ providers: [] }));
  writeProfile('web', ['@deepseek-ai/dsh-base', 'writing-channel']);
  const plugin = join(dshHome, 'profiles', 'web', 'node_modules', 'writing-channel');
  mkdirSync(join(plugin, 'lib'), { recursive: true });
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: 'writing-channel', version: '1.0.0', main: 'lib/index.js' }));
  // 插件把凭据物化在它看到的 DSH home；把该路径放进 provider 名称，父进程即可核对
  // 查询看到的是临时 home 而不是用户的真实 DSH home。
  writeFileSync(join(plugin, 'lib', 'index.js'), `import {mkdirSync, writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    export const inject = ['llm'];
    export async function apply(ctx) {
      const home = process.env.DSH_HOME;
      mkdirSync(join(home, 'storages'), { recursive: true });
      writeFileSync(join(home, 'storages', 'channel-credentials.json'), '{"token":"fixture"}');
      ctx.llm.extra.push({ id: 'subscription', name: home, models: [{ id: 'sub-model', name: 'Sub', reasoningEfforts: [] }] });
    }`);
  const result = await discoverDshModels({ dshRoot, dshHome, profile: 'web' });
  const seen = result.providers.find(provider => provider.id === 'subscription');
  expect(seen?.models.map(model => model.id)).toEqual(['sub-model']);
  expect(seen?.name).not.toBe(dshHome);
  expect(seen?.name.startsWith(dshHome)).toBe(false);
  expect(readdirSync(dshHome).some(name => name === 'storages' || name.startsWith('fsa-dsh-catalog'))).toBe(false);
});

it('未支持的profile名不启动SDK或假称包含其额外插件路由', async () => {
  const result = await discoverDshModels({ dshRoot: 'missing', dshHome: 'missing', profile: 'custom/sdk' });
  expect(result.providers).toEqual([]); expect(result.warning).toContain('profile'); expect(result.warning).toContain('手工填写');
});

it('尚未初始化的profile返回手工输入提示而不是原生目录', async () => {
  writeFileSync(join(dshHome, 'settings.yaml'), JSON.stringify({ providers: [
    { id: 'gateway-a', name: 'A', models: [{ id: 'plain', name: 'Plain' }] },
  ] }));
  const result = await discoverDshModels({ dshRoot, dshHome, profile: 'headless' });
  expect(result.providers).toEqual([]);
  expect(result.warning).toContain('手工填写');
});

it('目录模块不结算时12秒内终止子进程并回收临时目录', async () => {
  const existing = new Set(readdirSync(tmpdir()).filter(name => name.startsWith('fsa-dsh-catalog-')));
  writeFileSync(join(dshHome, 'settings.yaml'), JSON.stringify({ providers: [], action: 'hang' }));
  const started = performance.now();
  const result = await discoverDshModels({ dshRoot, dshHome });
  expect(performance.now() - started).toBeLessThan(14_500);
  expect(result.providers).toEqual([]); expect(result.warning).toContain('手工填写');
  expect(readdirSync(tmpdir()).filter(name => name.startsWith('fsa-dsh-catalog-') && !existing.has(name))).toEqual([]);
}, 15_000);
