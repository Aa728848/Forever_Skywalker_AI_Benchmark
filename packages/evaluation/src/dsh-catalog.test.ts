import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverDshModels, discoverDshPresets, profilePluginSpecifiers } from './dsh-catalog.ts';

let scratch: string;
let dshRoot: string;
let dshHome: string;

function write(path: string, value: string) {
  const target = join(dshRoot, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, value);
}

/** 预设探测夹具：在安装目录内写一个 web-app bundle 补丁层。 */
function writeBundleManifest(patches: string[]) {
  write('packages/bundle/web-app/package.json', JSON.stringify({ name: '@deepseek-ai/dsh-web-app', version: '0.1.7-rc.2', dsh: { bundle: { patch: patches } } }));
}

function writePresetFile(name: string, text: string) {
  write('packages/bundle/web-app/presets/' + name, text);
}

/** 复刻 DSH 的声明写法：一条 insert 行，config 里带 id/order 与一个 plugins 入口列表。 */
function presetYaml(id: string, order: number, extra: string[] = []) {
  return [
    '# Agent preset ' + id,
    '- insert:',
    '    - id: preset-' + id,
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: ' + id,
    '        order: ' + order,
    ...extra,
    '        plugins:',
    '          - id: persona',
    "            name: '@deepseek-ai/dsh-persona'",
    '            config:',
    '              suffix: Your working directory is {{cwd}}.',
    '',
  ].join('\n');
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
  // 夹具反映 DSH 当前布局：目录查询只装载 llm 运行时与各适配器（无 settings 宿主插件），
  // 且适配器是「具名导出 apply/inject 的模块」而非默认导出插件对象。
  // cordis 从 llm 包解析（worker 的 createRequire 锚点）。
  write('packages/llm/llm/node_modules/@deepseek-ai/cordis/package.json', JSON.stringify({ type: 'module', exports: './index.js' }));
  write('packages/llm/llm/node_modules/@deepseek-ai/cordis/index.js', `export class Context {
    fiber={dispose:async()=>{}};
    services={};
    provide(name,value){this.services[name]=value;}
    get(name){return this.services[name];}
    async plugin(plugin,config){if(typeof plugin==='function')new plugin(this,config);else await plugin.apply(this,config);}
  }`);
  write('packages/llm/llm/lib/index.js', `export class LlmRuntime {
    constructor(ctx){this.ctx=ctx;ctx.llm=this;ctx.llmRuntime=this;this.registered=[];this.extra=[];}
    listProviders(){return [...this.registered,...this.extra];}
    async listModels(provider){return this.listProviders().find(item=>item.id===provider).models;}
    async resolveModelInfo(provider,id){const model=(await this.listModels(provider)).find(item=>item.id===id);return model.reasoningEfforts?{reasoning:{efforts:model.reasoningEfforts.map(id=>({id}))}}:{};}
  }`);
  // 原生适配器：自身不持有 provider，而是把 settings.yaml 里声明的路由注册进 llm 运行时。
  write('packages/llm/llm-deepseek-api-key/lib/index.js', `import {readFileSync} from 'node:fs';
    import {join} from 'node:path';
    export const inject=['llm'];
    export async function apply(ctx){
      const file=join(process.env.DSH_HOME,'settings.yaml');
      const config=JSON.parse(readFileSync(file,'utf8'));
      ctx.llm.registered.push(...(config.providers??[]));
    }
  `);
  write('packages/llm/llm-pi-ai/lib/index.js', `import {readFileSync,writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    export const inject=['llm'];
    export async function apply(ctx){
      const settings=JSON.parse(readFileSync(join(process.env.DSH_HOME,'settings.yaml'),'utf8'));
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

describe('本地 DSH 预设枚举', () => {
  it('按声明顺序列出补丁层里的预设，并只回传相对安装目录的来源', () => {
    writeBundleManifest(['./cordis.patch.yml', './presets/standard.patch.yml', './presets/ptc.patch.yml', './presets/minimal.patch.yml', './presets/cordis.patch.yml']);
    writePresetFile('standard.patch.yml', presetYaml('standard', 1));
    writePresetFile('ptc.patch.yml', presetYaml('ptc', 2));
    writePresetFile('minimal.patch.yml', presetYaml('minimal', 3));
    writePresetFile('cordis.patch.yml', presetYaml('cordis', 4, ['        name: Cordis']));
    const result = discoverDshPresets({ dshRoot });
    expect(result.presets.map(preset => [preset.id, preset.order])).toEqual([['standard', 1], ['ptc', 2], ['minimal', 3], ['cordis', 4]]);
    expect(result.presets[3]!.name).toBe('Cordis');
    expect(result.presets[0]!.source).toEqual({ kind: 'bundle', file: join('packages', 'bundle', 'web-app', 'presets', 'standard.patch.yml') });
    // 来源是相对路径：绝对安装路径不进入目录协议。
    expect(JSON.stringify(result)).not.toContain(resolve(dshRoot));
    expect(result.warning).toContain('不启动 DSH');
  });

  it('同一 id 的重复声明只保留清单里先出现的文件，最终列表仍按声明 order 排序', () => {
    writeBundleManifest(['./presets/ptc.patch.yml', './presets/standard.patch.yml']);
    writePresetFile('standard.patch.yml', presetYaml('standard', 9));
    writePresetFile('ptc.patch.yml', presetYaml('ptc', 2) + presetYaml('standard', 1));
    const result = discoverDshPresets({ dshRoot });
    // 先出现的文件（ptc.patch.yml）对 standard 的声明胜出，因此 order 是 1 而不是 9；列表按 order 排序。
    expect(result.presets.map(preset => [preset.id, preset.order])).toEqual([['standard', 1], ['ptc', 2]]);
    expect(result.presets[0]!.source.file).toContain('ptc.patch.yml');
  });

  it('目录里多余的补丁文件即使不在清单中也按文件名补上', () => {
    writeBundleManifest(['./cordis.patch.yml']);
    writePresetFile('standard.patch.yml', presetYaml('standard', 1));
    const result = discoverDshPresets({ dshRoot });
    expect(result.presets.map(preset => preset.id)).toEqual(['standard']);
  });

  it('目录不存在或没有声明式补丁层时返回空列表与原因，而不是抛异常', () => {
    const missing = discoverDshPresets({ dshRoot: join(scratch, 'missing-dsh') });
    expect(missing.presets).toEqual([]);
    expect(missing.warning).toContain('内置的 standard、ptc、minimal、cordis');

    writeBundleManifest(['./cordis.patch.yml']);
    const none = discoverDshPresets({ dshRoot });
    expect(none.presets).toEqual([]);
    expect(none.warning).toContain('没有声明式预设补丁层');
  });

  it('坏 YAML 只跳过该文件并记一条可读原因，其余预设照常列出', () => {
    writeBundleManifest(['./presets/broken.patch.yml', './presets/standard.patch.yml']);
    writePresetFile('standard.patch.yml', presetYaml('standard', 1));
    writePresetFile('broken.patch.yml', '- insert:\n  - id: preset-broken\n    name: "unclosed\n');
    const result = discoverDshPresets({ dshRoot });
    expect(result.presets.map(preset => preset.id)).toEqual(['standard']);
    expect(result.warning).toContain('broken.patch.yml');
    expect(result.warning).toContain('有 1 个文件未能解析');
  });

  it('全部文件都坏时返回空列表与解析原因', () => {
    writeBundleManifest(['./presets/broken.patch.yml']);
    writePresetFile('broken.patch.yml', 'id: standard\nconfig:\n  order: 1\n');
    const mapping = discoverDshPresets({ dshRoot });
    expect(mapping.presets).toEqual([]);
    expect(mapping.warning).toContain('顶层不是补丁数组');

    writePresetFile('broken.patch.yml', '不是 YAML 数组\n');
    const garbage = discoverDshPresets({ dshRoot });
    expect(garbage.presets).toEqual([]);
    expect(garbage.warning).toContain('未能从本地 DSH 安装读出预设');
  });

  it('声明结构不完整（缺 config.id、缺 config、name 不是预设插件）时不编造预设', () => {
    writeBundleManifest(['./presets/mixed.patch.yml']);
    writePresetFile('mixed.patch.yml', [
      '- insert:',
      '    - id: preset-no-config',
      "      name: '@deepseek-ai/dsh-agent-preset'",
      '    - id: preset-no-id',
      "      name: '@deepseek-ai/dsh-agent-preset'",
      '      config:',
      '        order: 7',
      '    - id: other-row',
      "      name: '@deepseek-ai/dsh-other-plugin'",
      '      config:',
      '        id: standard',
      '        order: 1',
      '    - id: preset-good',
      "      name: '@deepseek-ai/dsh-agent-preset'",
      '      config:',
      '        id: good',
      '        order: 5',
      '        plugins: []',
      '',
    ].join('\n'));
    const result = discoverDshPresets({ dshRoot });
    expect(result.presets.map(preset => [preset.id, preset.order])).toEqual([['good', 5]]);
  });

  it('越界的补丁路径（含符号链接目标）一律不读', () => {
    const outside = join(scratch, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'escaped.patch.yml'), presetYaml('escaped', 1));
    writeBundleManifest(['../../outside/escaped.patch.yml']);
    const escaped = discoverDshPresets({ dshRoot });
    expect(escaped.presets).toEqual([]);
    expect(JSON.stringify(escaped)).not.toContain('escaped');

    // 安装目录内的链接指向越界文件时同样跳过。
    const link = join(dshRoot, 'packages', 'bundle', 'web-app', 'presets', 'linked.patch.yml');
    writeBundleManifest([]);
    try {
      symlinkSync(join(outside, 'escaped.patch.yml'), link, 'file');
    } catch { return; }
    const linked = discoverDshPresets({ dshRoot });
    expect(linked.presets.map(preset => preset.id)).not.toContain('escaped');
  });

  it('预设探测不启动 CLI/profile，也不读取任何凭据文件', () => {
    writeBundleManifest(['./presets/standard.patch.yml']);
    writePresetFile('standard.patch.yml', presetYaml('standard', 1));
    // applications 目录里的可执行文件会在被启动时抛错；凭据文件被改动即可察觉。
    write('apps/cli/lib/bin.js', 'throw new Error("CLI must not start");');
    const credentials = join(dshHome, '.credentials.yaml');
    writeFileSync(credentials, 'private-test-value');
    const result = discoverDshPresets({ dshRoot });
    expect(result.presets.map(preset => preset.id)).toEqual(['standard']);
    expect(readFileSync(credentials, 'utf8')).toBe('private-test-value');
    expect(JSON.stringify(result)).not.toContain('private-test-value');
  });
});
