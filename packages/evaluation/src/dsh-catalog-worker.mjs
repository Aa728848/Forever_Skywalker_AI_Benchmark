import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path, { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { modules, dshHome, extraPlugins = [] } = JSON.parse(process.argv[2]);
const blocked = () => { throw new Error('local catalog operation is unavailable'); };

// 目录查询不发起任何传输、子进程或监听；订阅渠道插件需要把凭据物化到本次临时
// DSH home，因此除该临时 home 外的写入被拒绝（见下方写路径守卫）。
globalThis.fetch = blocked;
for (const owner of [http, https]) for (const name of ['request', 'get']) owner[name] = blocked;
for (const name of ['connect', 'createConnection']) net[name] = blocked;
net.Socket.prototype.connect = blocked; net.Server.prototype.listen = blocked;
tls.connect = blocked; dgram.createSocket = blocked;
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[name] = blocked;
const sensitive = /(?:^|[\\/])(?:\.credentials(?:\.(?:yaml|yml|json))?|\.env(?:\.[^\\/]*)?|auth\.json|tokens?\.json)$/i;
const readable = target => { if (sensitive.test(String(target))) blocked(); };
for (const owner of [fs, fsPromises]) for (const name of ['readFile', 'readFileSync', 'createReadStream']) if (name in owner) {
  const original = owner[name]; owner[name] = function(target, ...args) { readable(target); return original.call(this, target, ...args); };
}
// 目录查询只允许插件把派生状态（凭据、模型设置）物化到本次查询的临时 DSH home；
// 其它位置的写入一律拒绝：查询过程不得改写用户的真实 DSH home、项目文件或任何配置。
// 凭据文件本身仍不可读，插件只能写入自己的派生状态。
const temporaryRoots = [dshHome].map(entry => {
  try { return fs.realpathSync(entry); } catch { return path.resolve(entry); }
}).map(entry => (process.platform === 'win32' ? entry.toLowerCase() : entry));
const withinTemporaryRoot = target => {
  const absolute = process.platform === 'win32' ? path.resolve(String(target)).toLowerCase() : path.resolve(String(target));
  for (const candidate of [absolute, path.dirname(absolute)]) {
    for (const root of temporaryRoots) {
      const suffix = path.relative(root, candidate);
      if (suffix === '' || (!suffix.startsWith('..') && !path.isAbsolute(suffix))) return true;
    }
  }
  return false;
};
// 每个入口要检查的路径参数位置：symlink 的第一个参数是链接目标而非被写入的路径。
const writeTargets = {
  writeFile: [0], appendFile: [0], mkdir: [0], rm: [0], rmdir: [0], unlink: [0], truncate: [0],
  chmod: [0], chown: [0], mkdtemp: [0], createWriteStream: [0],
  rename: [0, 1], copyFile: [0, 1], cp: [0, 1], link: [0, 1], symlink: [1],
};
const guarded = (entry, positions, owner) => {
  if (!(entry in owner)) return;
  const original = owner[entry];
  owner[entry] = function(target, ...args) {
    for (const index of positions) {
      const candidate = index === 0 ? target : args[index - 1];
      if (typeof candidate === 'string' || Buffer.isBuffer(candidate)) { if (!withinTemporaryRoot(candidate)) blocked(); }
    }
    return original.call(this, target, ...args);
  };
};
for (const owner of [fs, fsPromises]) for (const [name, positions] of Object.entries(writeTargets)) {
  guarded(name, positions, owner);
  if (name + 'Sync' in owner) guarded(name + 'Sync', positions, owner);
}
for (const owner of [fs, fsPromises]) for (const name of ['open', 'openSync']) if (name in owner) {
  const original = owner[name]; owner[name] = function(target, flags, ...args) {
    readable(target);
    if (flags !== undefined && flags !== 'r' && flags !== 0) { if (!withinTemporaryRoot(target)) blocked(); }
    return original.call(this, target, flags, ...args);
  };
}
syncBuiltinESMExports();
// 模块日志可能包含配置错误详情；目录协议只允许以下白名单JSON。
for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) console[method] = () => {};

let context;
try {
  // 目录查询只需要 llm 运行时与各适配器；settings 不再参与：
  // DSH 已把 settings-file 换成需要 profileContext/configEditor 的宿主插件，
  // 本查询不启动 profile，因此不能也不需要装载它（适配器不读 settings 即可注册路由）。
  const require = createRequire(pathToFileURL(modules.llm));
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
  const { LlmRuntime } = await import(pathToFileURL(modules.llm).href);
  context = new Context();
  await context.plugin(LlmRuntime);
  // 适配器现在是具名导出模块（导出 apply/inject），不是默认导出的插件对象，
  // 因此按模块命名空间交给 cordis 装载。
  for (const specifier of [modules.deepseek, modules.pi]) {
    const adapter = await import(pathToFileURL(specifier).href);
    await context.plugin(adapter);
  }
  // 订阅渠道等额外内置插件：只读目录之外的路由由 DSH 设置的插件提供，父进程按同一
  // profile 派生出本次查询要装载的本地插件包。单个插件装载失败只记录失败，不阻断
  // 其它本地目录，也不阻断手工输入入口。
  //
  // 这里不启动 CLI/profile，也不建立代理会话或凭据提供方。但插件声明注入的宿主服务
  // （Web 路由、工具注册表、附件、Loader、Web provider 选择）在本进程并不存在，
  // 缺少它们会让插件停在 pending，于是它的路由完全不可见。因此这里提供惰性占位：
  // 只满足同步注册（返回可释放句柄），任何真正产生副作用或读取数据的调用都抛出
  // 明确错误，而不是静默返回假数据。
  const disposer = () => () => {};
  const unused = name => () => { throw new Error('目录查询不提供 ' + name); };
  context.provide('webServer', { host: '127.0.0.1', port: 0, register: disposer, route: disposer, use: disposer, on: disposer });
  context.provide('tools', { register: disposer, guard: disposer, restrict: disposer, get: () => undefined });
  context.provide('attachments', { read: unused('attachments.read'), store: unused('attachments.store') });
  context.provide('loader', { entries: () => [], create: unused('loader.create'), await: async () => {} });
  context.provide('web', { registerSearchProvider: disposer, registerFetchProvider: disposer });
  // 订阅渠道插件声明注入 settings。DSH 0.1.7 把 settings-file 换成了需要
  // profileContext/configEditor 的宿主服务，本查询不启动 profile，因此提供同形状的
  // register 接缝：插件的 settings-compat 正是为「没有 settings 服务的组合」准备的，
  // 它只需要 register(ns, schema) 返回带 get/watch 的作用域。缺少它时插件会永远停在
  // pending，于是订阅渠道的 provider、模型与自带预设全部不可见（而不是报错）。
  // 关键：这里刻意不提供 register。订阅渠道的 settings-compat 用
  // hasRegister(settings) 在两条存储路径间选择——有 register 就走「本次进程内存里的
  // 命名空间作用域」，没有就走插件自己的文件存储（$DSH_HOME/storages/*-models.json）。
  // 目录查询要把真实已登录状态读出来，就必须让它走文件存储；给一个内存 register 会让
  // 它读到空状态，于是已登录的订阅渠道全部显示 0 个模型。
  context.provide('settings', { describe: () => [] });
  const extraFailures = [];
  for (const spec of extraPlugins) {
    try {
      const loaded = await import(spec.specifier);
      await context.plugin(loaded, {});
    } catch (error) {
      extraFailures.push(spec.id + '：' + (error instanceof Error ? error.message : String(error)));
    }
  }
  const providers = [];
  for (const provider of context.llm.listProviders()) {
    const models = [];
    try {
      for (const model of await context.llm.listModels(provider.id)) {
        let reasoningEfforts = [];
        try {
          const resolved = await context.llm.resolveModelInfo(provider.id, model.id);
          reasoningEfforts = resolved.reasoning?.efforts.map(effort => effort.id) ?? [];
        } catch { /* 不可解析的能力不猜测，向导仍可使用default。 */ }
        models.push({ id: model.id, name: model.name, reasoningEfforts });
      }
    } catch { /* 一个不可读provider不阻断其它本地目录，保留手工输入入口。 */ }
    providers.push({ id: provider.id, name: provider.name, models });
  }
  await context.fiber.dispose(); context = undefined;
  process.stdout.write(JSON.stringify({ providers, extraFailures }));
} catch {
  try { await context?.fiber.dispose(); } catch { /* 父进程超时兜底，原错误详情不输出。 */ }
  process.exitCode = 1;
}
