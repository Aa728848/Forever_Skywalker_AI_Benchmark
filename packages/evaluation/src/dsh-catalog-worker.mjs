import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { modules, dshHome } = JSON.parse(process.argv[2]);
const blocked = () => { throw new Error('local catalog operation is unavailable'); };

// 只读目录查询不需要任何传输、子进程、监听器或持久写入。
globalThis.fetch = blocked;
for (const owner of [http, https]) for (const name of ['request', 'get']) owner[name] = blocked;
for (const name of ['connect', 'createConnection']) net[name] = blocked;
net.Socket.prototype.connect = blocked; net.Server.prototype.listen = blocked;
tls.connect = blocked; dgram.createSocket = blocked;
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[name] = blocked;
for (const name of ['writeFile', 'appendFile', 'mkdir', 'rm', 'rmdir', 'unlink', 'rename', 'copyFile', 'cp', 'truncate', 'chmod', 'chown', 'symlink', 'link', 'mkdtemp']) {
  if (name in fsPromises) fsPromises[name] = blocked;
  if (name in fs) fs[name] = blocked;
  if (name + 'Sync' in fs) fs[name + 'Sync'] = blocked;
}
for (const name of ['write', 'writeSync', 'writev', 'writevSync', 'createWriteStream']) fs[name] = blocked;
const sensitive = /(?:^|[\\/])(?:\.credentials(?:\.(?:yaml|yml|json))?|\.env(?:\.[^\\/]*)?|auth\.json|tokens?\.json)$/i;
const readable = path => { if (sensitive.test(String(path))) blocked(); };
for (const owner of [fs, fsPromises]) for (const name of ['readFile', 'readFileSync', 'createReadStream']) if (name in owner) {
  const original = owner[name]; owner[name] = function(path, ...args) { readable(path); return original.call(this, path, ...args); };
}
for (const owner of [fs, fsPromises]) for (const name of ['open', 'openSync']) if (name in owner) {
  const original = owner[name]; owner[name] = function(path, flags, ...args) {
    readable(path); if (flags !== undefined && flags !== 'r' && flags !== 0) blocked();
    return original.call(this, path, flags, ...args);
  };
}
syncBuiltinESMExports();
// 模块日志可能包含配置错误详情；目录协议只允许以下白名单JSON。
for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) console[method] = () => {};

let context;
try {
  const require = createRequire(pathToFileURL(modules.settings));
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
  const [{ FileSettingsProvider }, { LlmRuntime }, deepseek, pi] = await Promise.all(
    [modules.settings, modules.llm, modules.deepseek, modules.pi].map(path => import(pathToFileURL(path).href)),
  );
  context = new Context();
  await context.plugin(FileSettingsProvider, { path: join(dshHome, 'settings.yaml'), watch: false });
  await context.plugin(LlmRuntime);
  await context.plugin(deepseek, {});
  await context.plugin(pi, {});
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
  process.stdout.write(JSON.stringify({ providers }));
} catch {
  try { await context?.fiber.dispose(); } catch { /* 父进程超时兜底，原错误详情不输出。 */ }
  process.exitCode = 1;
}
