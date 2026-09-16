import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkDshInstallation } from './dsh.ts';

export interface DshCatalogModel { id: string; name: string; reasoningEfforts: string[] }
export interface DshCatalogProvider { id: string; name: string; models: DshCatalogModel[] }
export interface DshCatalogOptions { dshRoot: string; dshHome: string; profile?: string }
export interface DshModelCatalog { providers: DshCatalogProvider[]; warning: string | null }

const fallback = '无法读取本地 DSH 模型目录，请手工填写供应商 ID 和模型 ID；不会自动探测远程端点。';
const scopeNotice = '目录来自本地 DSH 配置、原生适配器与当前 profile 已安装的插件包（订阅渠道同样在此列为供应商）；列表不验证凭据、额度或远程可用性。';
const timeoutMs = 12_000;
const maxOutputBytes = 2 * 1024 * 1024;
const maxPlugins = 32;
const packageName = /^(?:@[a-z0-9-._~]+\/)?[a-z0-9-._~]+$/i;

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
  // 插件装载失败只影响该插件自己的路由，父进程只把它作为提示，不影响已取得的目录。
  // 插件失败原因可能带着配置或凭据片段，不进入目录协议；这里只保留失败插件的标识，
  // 让向导能提示“该插件的模型请手工填写”，具体原因由插件自己在 DSH 内报告。
  const reported = (raw as { extraFailures?: unknown }).extraFailures;
  const failures = Array.isArray(reported)
    ? (reported as unknown[]).slice(0, maxPlugins).map(failure => typeof failure === 'string' ? failure.split('：')[0]!.trim() : '').filter(text)
    : [];
  const warning = providers.length === 0 ? fallback
    : failures.length === 0 ? scopeNotice
      : scopeNotice + ' 有 ' + failures.length + ' 个插件未能装载（' + failures.join('、') + '），其路由请手工填写；其余路由已按可读取结果列出。';
  return { providers, warning };
}

/**
 * 解析一个已初始化 profile 中可参与模型目录的本地插件包：只读取包名与入口路径，
 * 不读取包内配置、凭据或任何账户信息；DSH 安装目录自带的 bundle 由 worker 自行
 * 装载，注册表包无法定位入口时跳过并保留手工输入。
 */
export function profilePluginSpecifiers(dshRoot: string, dshHome: string, profile: string): { plugins: { id: string; specifier: string }[]; skipped: string[] } {
  const plugins: { id: string; specifier: string }[] = [];
  const skipped: string[] = [];
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(profile) || profile === '.' || profile === '..') return { plugins, skipped };
  const profileDir = join(dshHome, 'profiles', profile);
  const manifestPath = join(profileDir, 'package.json');
  if (!existsSync(manifestPath)) return { plugins, skipped };
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dsh?: { profile?: { bundles?: unknown } } };
  const bundles = manifest.dsh?.profile?.bundles;
  if (!Array.isArray(bundles)) return { plugins, skipped };
  const installation = realpathSync(dshRoot);
  const paths = (anchor: string, name: string): string[] => {
    const candidates: string[] = [];
    let directory = anchor;
    while (true) {
      const parent = dirname(directory);
      if (parent === directory) break;
      if (basename(directory) !== 'node_modules') candidates.push(join(directory, 'node_modules', name));
      directory = parent;
    }
    return candidates;
  };
  for (const name of bundles) {
    if (plugins.length >= maxPlugins) break;
    if (!text(name) || !packageName.test(name)) { skipped.push(String(name).slice(0, 64)); continue; }
    const bundle = name;
    const location = paths(profileDir, bundle).find(candidate => existsSync(join(candidate, 'package.json')));
    if (location === undefined) { skipped.push(bundle); continue; }
    let directory: string;
    try { directory = realpathSync(location); } catch { skipped.push(bundle); continue; }
    // DSH 安装自带的 bundle 由 worker 按同一安装路径装载，此处不重复插入。
    if (directory === installation || directory.startsWith(installation + sep)) continue;
    try {
      const entry = pluginEntry(directory);
      if (entry === undefined) { skipped.push(bundle); continue; }
      plugins.push({ id: bundle, specifier: pathToFileURL(entry).href });
    } catch { skipped.push(bundle); }
  }
  return { plugins, skipped };
}

/** ESM 运行时条件的优先顺序；types/typings 是声明文件，不能作为运行时入口。 */
const runtimeConditions = ['default', 'import', 'module', 'node', 'require'];

/** 只接受包自己声明的构建产物入口，且必须位于包目录内。 */
function pluginEntry(directory: string): string | undefined {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { exports?: unknown; main?: unknown };
  const declared: string[] = [];
  const exported = manifest.exports;
  if (typeof exported === 'string') declared.push(exported);
  else if (typeof exported === 'object' && exported !== null && !Array.isArray(exported)) {
    const root = (exported as Record<string, unknown>)['.'];
    if (typeof root === 'string') declared.push(root);
    else if (typeof root === 'object' && root !== null && !Array.isArray(root)) {
      const conditions = root as Record<string, unknown>;
      for (const name of runtimeConditions) if (typeof conditions[name] === 'string') declared.push(conditions[name] as string);
      for (const [name, value] of Object.entries(conditions)) {
        if (name === 'types' || name === 'typings' || runtimeConditions.includes(name)) continue;
        if (typeof value === 'string') declared.push(value);
      }
    }
  }
  if (typeof manifest.main === 'string') declared.push(manifest.main);
  declared.push('lib/index.js', 'index.js');
  for (let index = declared.length - 1; index >= 0; index -= 1) if (/\.d\.(?:c|m)?ts$/.test(declared[index]!)) declared.splice(index, 1);
  for (const candidate of declared) {
    const absolute = resolve(directory, candidate);
    const suffix = relative(directory, absolute);
    if (suffix.startsWith('..') || isAbsolute(suffix) || !existsSync(absolute) || !statSync(absolute).isFile()) continue;
    return absolute;
  }
  return undefined;
}

/** 只加载受支持的本地目录模块；不启动CLI/profile、代理会话或凭据提供方。 */
export async function discoverDshModels(options: DshCatalogOptions): Promise<DshModelCatalog> {
  let scratch: string | undefined;
  try {
    if (options.profile !== undefined && (options.profile === '' || /[\\/]/.test(options.profile) || options.profile === '.' || options.profile === '..')) {
      return { providers: [], warning: '自动目录需要一个 DSH profile 名称；当前 profile 请手工填写供应商 ID 和模型 ID。' };
    }
    const { dshRoot } = checkDshInstallation(options.dshRoot);
    const dshHome = realpathSync(options.dshHome);
    if (!statSync(dshHome).isDirectory()) throw new Error('missing home');
    const profile = options.profile ?? 'sdk';
    if (!existsSync(join(dshHome, 'profiles', profile, 'package.json'))) {
      return { providers: [], warning: '当前 profile 尚未在 ' + join(dshHome, 'profiles', profile) + ' 初始化；请手工填写供应商 ID 和模型 ID，或先用 dsh 初始化该 profile。' };
    }
    // 无法定位入口的包（注册表包不在本地）保留手工输入入口，不写入目录协议。
    const plugins = profilePluginSpecifiers(dshRoot, dshHome, profile);
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
    // 插件把凭据与模型设置物化在 $DSH_HOME 下：给本次查询一个临时 home，
    // 只复制非机密的 settings.yaml（其内容同时决定哪些模型被勾选），
    // 任何写入都留在临时目录并与父进程一起回收。
    const catalogHome = join(scratch, 'home');
    mkdirSync(catalogHome, { recursive: true });
    const settingsPath = join(dshHome, 'settings.yaml');
    if (existsSync(settingsPath)) cpSync(settingsPath, join(catalogHome, 'settings.yaml'));
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) if (['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'].includes(key.toUpperCase())) env[key] = value;
    env.DSH_TELEMETRY_DISABLED = '1';
    env.DSH_HOME = catalogHome;
    const result = await new Promise<string>((resolveOutput, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./dsh-catalog-worker.mjs', import.meta.url)), JSON.stringify({ modules, dshHome: catalogHome, extraPlugins: plugins.plugins })], {
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
