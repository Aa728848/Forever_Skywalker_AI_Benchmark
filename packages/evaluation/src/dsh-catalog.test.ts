import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { discoverDshModels } from './dsh-catalog.ts';

let scratch: string;
let dshRoot: string;
let dshHome: string;

function write(path: string, value: string) {
  const target = join(dshRoot, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, value);
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
    async plugin(plugin,config){if(typeof plugin==='function')new plugin(this,config);else await plugin.apply(this,config);}
  }`);
  write('packages/settings/settings-file/lib/index.js', `import {readFileSync} from 'node:fs';
    export class FileSettingsProvider {constructor(ctx,config){if(config.watch!==false)throw new Error('watch must be disabled');ctx.settings=JSON.parse(readFileSync(config.path,'utf8'));}}
  `);
  write('packages/llm/llm/lib/index.js', `export class LlmRuntime {
    constructor(ctx){this.ctx=ctx;ctx.llm=this;}
    listProviders(){return this.ctx.settings.providers;}
    async listModels(provider){return this.ctx.settings.providers.find(item=>item.id===provider).models;}
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
  expect(result.warning).toContain('额外插件');
  expect(JSON.stringify(result)).not.toContain('private-test-value');
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

it('未支持的profile不启动SDK或假称包含其额外插件路由', async () => {
  const result = await discoverDshModels({ dshRoot: 'missing', dshHome: 'missing', profile: 'custom-sdk' });
  expect(result.providers).toEqual([]); expect(result.warning).toContain('profile'); expect(result.warning).toContain('手工填写');
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
