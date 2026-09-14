import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDshInstallation } from './dsh.ts';

export interface DshCatalogModel { id: string; name: string; reasoningEfforts: string[] }
export interface DshCatalogProvider { id: string; name: string; models: DshCatalogModel[] }
export interface DshCatalogOptions { dshRoot: string; dshHome: string; profile?: string }
export interface DshModelCatalog { providers: DshCatalogProvider[]; warning: string | null }

const fallback = '无法读取本地 DSH 模型目录，请手工填写供应商 ID 和模型 ID；不会自动探测远程端点。';
const scopeNotice = '目录来自本地 DeepSeek/Pi-ai 适配器及 DSH settings；额外插件或 profile 覆盖的路由请手工输入，列表不验证凭据或远程可用性。';
const timeoutMs = 12_000;
const maxOutputBytes = 2 * 1024 * 1024;

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
}

/** 白名单投影，父进程不接收或转发任意配置/错误对象。 */
function catalogOutput(output: string): DshModelCatalog {
  const raw: unknown = JSON.parse(output);
  if (typeof raw !== 'object' || raw === null || !('providers' in raw) || !Array.isArray(raw.providers) || raw.providers.length > 128) throw new Error('invalid catalog');
  const providers: DshCatalogProvider[] = [];
  const providerIds = new Set<string>();
  for (const provider of raw.providers as unknown[]) {
    if (typeof provider !== 'object' || provider === null) throw new Error('invalid provider');
    const item = provider as Record<string, unknown>;
    if (!text(item.id) || !text(item.name) || providerIds.has(item.id) || !Array.isArray(item.models) || item.models.length > 4096) throw new Error('invalid provider');
    providerIds.add(item.id);
    const models: DshCatalogModel[] = [];
    const modelIds = new Set<string>();
    for (const model of item.models as unknown[]) {
      if (typeof model !== 'object' || model === null) throw new Error('invalid model');
      const entry = model as Record<string, unknown>;
      if (!text(entry.id) || !text(entry.name) || modelIds.has(entry.id) || !Array.isArray(entry.reasoningEfforts)
        || entry.reasoningEfforts.length > 32 || !entry.reasoningEfforts.every(effort => typeof effort === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(effort))) throw new Error('invalid model');
      modelIds.add(entry.id);
      models.push({ id: entry.id, name: entry.name, reasoningEfforts: [...new Set(entry.reasoningEfforts as string[])] });
    }
    providers.push({ id: item.id, name: item.name, models });
  }
  return { providers, warning: providers.length === 0 ? fallback : scopeNotice };
}

/** 只加载受支持的本地目录模块；不启动CLI/profile、代理会话或凭据提供方。 */
export async function discoverDshModels(options: DshCatalogOptions): Promise<DshModelCatalog> {
  let scratch: string | undefined;
  try {
    if (options.profile !== undefined && options.profile !== 'sdk') return { providers: [], warning: '自动目录仅支持标准 sdk 配置；当前 profile 请手工填写供应商 ID 和模型 ID。' };
    const { dshRoot } = checkDshInstallation(options.dshRoot);
    const dshHome = realpathSync(options.dshHome);
    if (!statSync(dshHome).isDirectory()) throw new Error('missing home');
    const modules = Object.fromEntries(Object.entries({
      settings: 'packages/settings/settings-file/lib/index.js',
      llm: 'packages/llm/llm/lib/index.js',
      deepseek: 'packages/llm/llm-deepseek/lib/index.js',
      pi: 'packages/llm/llm-pi-ai/lib/index.js',
    }).map(([key, path]) => {
      const location = realpathSync(join(dshRoot, path));
      const suffix = relative(dshRoot, location);
      if (suffix.startsWith('..') || isAbsolute(suffix) || !statSync(location).isFile()) throw new Error('invalid installation');
      return [key, location];
    }));
    scratch = mkdtempSync(join(tmpdir(), 'fsa-dsh-catalog-'));
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) if (['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'].includes(key.toUpperCase())) env[key] = value;
    env.DSH_TELEMETRY_DISABLED = '1';
    const result = await new Promise<string>((resolveOutput, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./dsh-catalog-worker.mjs', import.meta.url)), JSON.stringify({ modules, dshHome })], {
        cwd: scratch, env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
      });
      const chunks: Buffer[] = [];
      let bytes = 0, failure: Error | undefined;
      const stop = (message: string) => { failure ??= new Error(message); child.kill('SIGKILL'); };
      const timer = setTimeout(() => stop('catalog timeout'), timeoutMs);
      child.once('error', () => { failure = new Error('catalog process failed'); });
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxOutputBytes) stop('catalog output limit');
        else chunks.push(chunk);
      });
      child.once('close', code => {
        clearTimeout(timer);
        if (failure || code !== 0) reject(failure ?? new Error('catalog unavailable'));
        else resolveOutput(Buffer.concat(chunks).toString('utf8'));
      });
    });
    return catalogOutput(result);
  } catch {
    return { providers: [], warning: fallback };
  } finally {
    if (scratch) {
      const location = resolve(scratch);
      if (dirname(location) !== resolve(tmpdir()) || !basename(location).startsWith('fsa-dsh-catalog-')) throw new Error('目录查询临时路径越界。');
      rmSync(location, { recursive: true, force: true });
    }
  }
}
