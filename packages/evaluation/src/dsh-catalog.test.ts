import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverDshModels, discoverDshPresets, profilePluginSpecifiers } from './dsh-catalog.ts';

/** 仓库根：用来读本机的 .env（测试进程不自动加载它）。 */
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * 本机真实 DSH 安装：夹具从它复制 js-yaml，避免在项目内维护第二套 YAML 解析。
 * 未配置或不存在时，依赖它的用例会**跳过**，而不是硬编码路径后假装通过。
 */
function repositoryDshRootFromEnv(): string {
  const fromEnv = process.env.BENCH_DSH_ROOT?.trim();
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  try {
    return /^BENCH_DSH_ROOT=(.*)$/m.exec(readFileSync(join(workspaceRoot, '.env'), 'utf8'))?.[1]?.trim() ?? '';
  } catch { return ''; }
}
const repositoryDshRoot = (() => {
  const candidate = repositoryDshRootFromEnv();
  return candidate !== '' && existsSync(join(candidate, 'packages/llm/llm/lib/index.js')) ? candidate : '';
})();
/** 能从真实 DSH 解析出 js-yaml 时才返回目录；否则 null（用例据此跳过）。 */
function realJsYamlDirectory(): string | null {
  if (repositoryDshRoot === '') return null;
  try {
    return dirname(createRequire(pathToFileURL(join(repositoryDshRoot, 'packages/llm/llm/lib/index.js')).href).resolve('js-yaml'));
  } catch { return null; }
}
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
  // 夹具必须像真实 cordis 一样尊重 inject：声明注入的服务不存在时插件不应被应用。
  // 否则「插件因缺服务而停在 pending」这一真实故障会在测试里被静默通过。
  write('packages/llm/llm/node_modules/@deepseek-ai/cordis/index.js', `export class Context {
    fiber={dispose:async()=>{}};
    services={};
    provide(name,value){this.services[name]=value;}
    get(name){return this.services[name];}
    async plugin(plugin,config){
      const required = plugin?.inject ?? plugin?.default?.inject ?? [];
      for (const name of required) if (!(name in this.services) && this[name] === undefined) throw new Error('missing service: ' + name);
      if (typeof plugin==='function') new plugin(this,config); else await plugin.apply(this,config);
    }
  }`);
  // js-yaml 由 worker 经 llm 包解析（读 profile 补丁层时用它）。真实安装里它来自
  // DSH 的 node_modules；夹具复制**同一个实现**，避免在项目里维护第二套 YAML 语义。
  write('packages/llm/llm/node_modules/js-yaml/package.json', JSON.stringify({ name: 'js-yaml', version: '4.0.0', main: 'index.js' }));
  const yamlDirectory = realJsYamlDirectory();
  if (yamlDirectory !== null) cpSync(yamlDirectory, join(dshRoot, 'packages/llm/llm/node_modules/js-yaml'), { recursive: true });
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
  // 真实 llm-pi-ai 是「休眠」挂载：没有 config.providers 就注册 0 条路由。
  // 夹具必须同样尊重这一点，否则「不给档案时供应商不该出现」的断言失去意义。
  write('packages/llm/llm-pi-ai/lib/index.js', `import {readFileSync,writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    export const inject=['llm'];
    export async function apply(ctx,config){
      const settings=JSON.parse(readFileSync(join(process.env.DSH_HOME,'settings.yaml'),'utf8'));
      if(settings.action==='read-credentials')readFileSync(settings.target,'utf8');
      if(settings.action==='write')writeFileSync(settings.target,'changed');
      if(settings.action==='network')await fetch(settings.target);
      if(settings.action==='error')throw new Error(settings.secret);
      if(settings.action==='hang')await new Promise(()=>setInterval(()=>{},1000));
      for(const [id,profile] of Object.entries(config?.providers??{})){
        ctx.llm.registered.push({id,name:id,models:(profile.models??[]).map(m=>({id:m.id,name:m.name,reasoningEfforts:[]}))});
      }
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

it('为插件提供 settings 接缝，且刻意不带 register（否则订阅渠道读不到已勾选模型）', async () => {
  // 回归两件事：
  // 1) worker 必须提供 settings 服务：订阅渠道插件声明 inject settings，缺它插件永远停在
  //    pending，provider、模型与自带预设全部不可见且不报错；
  // 2) 该接缝**不能**提供 register：插件的 hasRegister() 在有 register 时改用本次进程的
  //    内存作用域（空），只有在没有 register 时才回落到 $DSH_HOME/storages/*-models.json。
  // 这里直接读源码固定这两条契约——它们是跨进程行为，夹具无法替真实 cordis 断言。
  const worker = readFileSync(new URL('./dsh-catalog-worker.mjs', import.meta.url), 'utf8');
  expect(worker).toContain("context.provide('settings'");
  const settingsProvide = worker.slice(worker.indexOf("context.provide('settings'"), worker.indexOf("describe: () => []"));
  expect(settingsProvide).not.toContain('register');
  // 模型设置必须随临时 home 一起提供给插件。
  expect(worker).toContain("context.provide('settings'");
  const catalog = readFileSync(new URL('./dsh-catalog.ts', import.meta.url), 'utf8');
  expect(catalog).toContain("-models\\.json$");
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

it('DSH 版本漂移时把真实失败原因带进 warning，而不是只回落到「请手工填写」', async () => {
  // 回归：外层 catch 曾把一切异常吞成通用提示。DSH 改名/移动资产时（本轮已发生三次：
  // settings-file、llm-deepseek、agent-presets），界面只显示「没探测到」，真实原因不可见。
  // 现在缺资产必须在 warning 里指名缺了哪个路径。
  const result = await discoverDshModels({ dshRoot, dshHome, profile: 'sdk' });
  expect(result.providers).toEqual([]);
  expect(result.warning).toContain('手工填写');
  // 必须指名缺了哪个 DSH 资产并说明是版本漂移，而不是只给一句通用提示。
  expect(result.warning).toContain('本机失败原因');
  expect(result.warning).toContain('本机缺少 DSH 资产');
  expect(result.warning).toContain('需同步适配');
  // 同时绝不能被异常原文带着泄漏：只回传结构化事实。
  expect(result.warning).not.toContain('fsa-catalog-test-');
  expect(result.warning).not.toContain('at Module');
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

describe('profile 补丁层里的 pi-ai provider 档案', () => {
  // 回归（2026-09-27）：base bundle 以「休眠」方式挂载 pi-ai 适配器——
  //   「mounted dormant: zero routes ... until a `llm-pi-ai:` settings section
  //    supplies provider profiles」（bundle/base/cordis.patch.yml:120）
  // 插件已加载，但没有 provider 档案就注册 0 条路由，于是 stepfun 这类 pi-ai 供应商
  // 永远不出现在目录里——即使凭据已在 ~/.dsh/.credentials.yaml。
  // 实测：传 config 后供应商从 7 变 8 且 stepfun 出现；不传则没有。
  // worker 现在自己从 profile 补丁层读该档案，因此这里断言的是**探测结果**，
  // 而不是某个中间函数——这样夹具必须真的把补丁层喂进解析路径。
  it.skipIf(realJsYamlDirectory() === null)('补丁层声明 llm-pi-ai 的 providers 时，其供应商出现在目录里', async () => {
    writeProfile('sdk', []);
    // 夹具的原生适配器用 JSON.parse 读 settings.yaml（JSON 是合法 YAML），因此这里也必须写 JSON。
    writeFileSync(join(dshHome, 'settings.yaml'), JSON.stringify({ providers: [] }));
    const patchPath = join(dshHome, 'profiles', 'sdk', 'cordis.patch.yml');
    // 不给档案：stepfun 不得出现。
    writeFileSync(patchPath, ['- id: llm-pi-ai', '  config:', '    providers: {}', ''].join('\n'));
    const without = await discoverDshModels({ dshRoot, dshHome, profile: 'sdk' });
    expect(without.providers.some(p => p.id === 'stepfun')).toBe(false);
    // 给出档案：stepfun 出现，且带上它的模型。
    writeFileSync(patchPath, [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      stepfun:',
      '        apiKeyEnv: STEPFUN_API_KEY',
      '        models:',
      '          - id: step-5-preview',
      '            name: step-5-preview',
      ''
    ].join('\n'));
    const with_ = await discoverDshModels({ dshRoot, dshHome, profile: 'sdk' });
    const stepfun = with_.providers.find(p => p.id === 'stepfun');
    expect(stepfun).toBeDefined();
    expect(stepfun!.models.map(m => m.id)).toEqual(['step-5-preview']);
  });
});
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