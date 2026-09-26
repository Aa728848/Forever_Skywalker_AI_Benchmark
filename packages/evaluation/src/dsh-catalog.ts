import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
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
    // 适配器入口按 DSH 当前布局给出：DeepSeek 原生适配器已从 llm-deepseek
    // 拆到 llm-deepseek-api-key，且两者都改为具名导出模块（见 worker 的装载说明）。
    // settings 不再参与：它现在是需要 profileContext/configEditor 的宿主插件，
    // 而本查询不启动 profile；适配器不需要它即可注册路由。
    const modules = Object.fromEntries(Object.entries({
      llm: 'packages/llm/llm/lib/index.js',
      deepseek: 'packages/llm/llm-deepseek-api-key/lib/index.js',
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

/* ── 预设枚举 ───────────────────────────────────────────────────────────────
 * DSH 把 Agent 预设写成声明式 YAML：web-app bundle 的补丁层在安装目录内，
 * 每个文件插入一条 name='@deepseek-ai/dsh-agent-preset' 的声明。枚举它们只需要
 * 读取本地文件，因此这里不启动 DSH 运行时、不调用模型、不联网，与
 * discoverDshModels 的边界一致；任何失败都返回空列表与可读原因而不是抛异常。
 */

export interface DshCatalogPreset {
  id: string;
  /** 声明里的展示名；声明未写时为 null，由调用方回退到内置中文标签。 */
  name: string | null;
  order: number;
  /** 相对 DSH 安装目录的补丁文件；不回传绝对路径。 */
  source: { kind: 'bundle'; file: string };
}

export interface DshPresetCatalog { presets: DshCatalogPreset[]; warning: string | null }
export interface DshPresetOptions { dshRoot: string }

const presetFallback = '无法读取本地 DSH 预设目录；请沿用内置的 standard、ptc、minimal、cordis。';
const presetScopeNotice = '预设来自本地 DSH 安装自带的声明式 YAML（web-app bundle 的 presets/*.patch.yml），按声明顺序排列；只读取文件，不启动 DSH、不联网、不调用模型，也不验证该预设在本机能否装载。';
const presetDeclarationName = '@deepseek-ai/dsh-agent-preset';
const maxPresetFiles = 64;
const maxPresetBytes = 512 * 1024;

/** YAML 结构不符合预设声明时抛出；调用方按文件跳过并记原因，不让一个坏文件拖垮整个目录。 */
class PresetParseError extends Error {}

interface PatchRow { indent: number; content: string }

/** 去掉行尾注释，但保留引号内的 #；# 只在行首或空白之后才开启注释（与 YAML 一致）。 */
function withoutComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (quote !== null) { if (character === quote) quote = null; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '#' && (index === 0 || line[index - 1] === ' ' || line[index - 1] === '\t')) return line.slice(0, index);
  }
  return line;
}

function patchRows(text: string): PatchRow[] {
  const rows: PatchRow[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const content = withoutComment(raw);
    if (content.trim() === '') continue;
    rows.push({ indent: content.length - content.trimStart().length, content: content.trim() });
  }
  return rows;
}

/** 找到「键: 值」的分隔冒号：冒号后必须是空白或行尾，避免把 URL 或 !!js 表达式误当分隔符。 */
function keySeparator(content: string): number {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!;
    if (quote !== null) { if (character === quote) quote = null; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === ':' && (index === content.length - 1 || content[index + 1] === ' ')) return index;
  }
  return -1;
}

function scalar(raw: string): unknown {
  // 自定义标签（!!js 等）与行内流式集合都不参与预设身份，按字面量保留即可。
  if (raw.startsWith('!!') || raw.startsWith('[') || raw.startsWith('{')) return raw;
  if (raw.startsWith('"') || raw.startsWith("'")) {
    const quote = raw[0]!;
    if (raw.length < 2 || !raw.endsWith(quote)) throw new PresetParseError('引号未闭合');
    const body = raw.slice(1, -1);
    return quote === '"'
      ? body.replace(/\\(.)/g, (_match, escaped: string) => escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped)
      : body.replace(/''/g, "'");
  }
  if (raw === 'null' || raw === '~') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  return raw;
}

/** 字面量（|）与折叠（>）块标量：内容不属于预设身份，整体跳过。 */
const blockScalar = (raw: string): boolean => /^[|>][+-]?\d*$/.test(raw);

function skipBlockScalar(rows: PatchRow[], index: number, indent: number): number {
  let next = index;
  while (next < rows.length && rows[next]!.indent > indent) next += 1;
  return next;
}

function parseMapping(rows: PatchRow[], start: number, indent: number, inline?: string): { value: Record<string, unknown>; next: number } {
  const value: Record<string, unknown> = {};
  let index = inline === undefined ? start : start + 1;
  let content = inline;
  while (true) {
    if (content === undefined) {
      const row = rows[index];
      if (row === undefined || row.indent !== indent || row.content === '-' || row.content.startsWith('- ')) break;
      content = row.content;
      index += 1;
    }
    const separator = keySeparator(content);
    if (separator <= 0) throw new PresetParseError('不是「键: 值」形式：' + content.slice(0, 40));
    const key = content.slice(0, separator).trim();
    const raw = content.slice(separator + 1).trim();
    if (blockScalar(raw)) { value[key] = null; index = skipBlockScalar(rows, index, indent); }
    else if (raw === '') {
      const row = rows[index];
      if (row !== undefined && row.indent > indent) {
        const nested = parseBlock(rows, index, row.indent);
        value[key] = nested.value;
        index = nested.next;
      } else value[key] = null;
    } else value[key] = scalar(raw);
    content = undefined;
  }
  return { value, next: index };
}

function parseSequence(rows: PatchRow[], start: number, indent: number): { value: unknown[]; next: number } {
  const items: unknown[] = [];
  let index = start;
  while (index < rows.length) {
    const row = rows[index]!;
    if (row.indent !== indent || !(row.content === '-' || row.content.startsWith('- '))) break;
    const inline = row.content === '-' ? '' : row.content.slice(2).trim();
    if (inline === '') {
      index += 1;
      if (index < rows.length && rows[index]!.indent > indent) {
        const nested = parseBlock(rows, index, rows[index]!.indent);
        items.push(nested.value);
        index = nested.next;
      } else items.push(null);
      continue;
    }
    // 行内起始的映射项：'- id: x' 与紧随其后同缩进的键属于同一项。
    // 也接受 '- !!js ...' 这类行内标量项（嵌套数组里可出现），此时整行只是一个值。
    if (keySeparator(inline) === -1) { items.push(scalar(inline)); index += 1; continue; }
    const nested = parseMapping(rows, index, indent + 2, inline);
    items.push(nested.value);
    index = nested.next;
  }
  return { value: items, next: index };
}

function parseBlock(rows: PatchRow[], start: number, indent: number): { value: unknown; next: number } {
  const row = rows[start];
  if (row === undefined || row.indent !== indent) throw new PresetParseError('缩进与结构不一致');
  return row.content === '-' || row.content.startsWith('- ')
    ? parseSequence(rows, start, indent)
    : parseMapping(rows, start, indent);
}

interface PresetDeclaration { id: string; name: string | null; order: number | null }

/** 一条 name='@deepseek-ai/dsh-agent-preset' 的声明同时接受 insert 内与按行 id 覆写两种写法。 */
function presetDeclaration(row: unknown): PresetDeclaration | null {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  if (record.name !== presetDeclarationName) return null;
  const raw = record.config;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const config = raw as Record<string, unknown>;
  // id 取声明自己写的 config.id：DSH 的注册表就是按它建行的，缺 id 的声明在 DSH 里根本激活不了，
  // 这里也不能凭行 id 替它编一个出来。
  const id = typeof config.id === 'string' ? config.id.trim() : '';
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) return null;
  const order = typeof config.order === 'number' && Number.isSafeInteger(config.order) ? config.order : null;
  const name = typeof config.name === 'string' && config.name.trim() !== '' ? config.name.trim().slice(0, 64) : null;
  return { id, name, order };
}

function declarationsIn(text: string): PresetDeclaration[] {
  const rows = patchRows(text);
  if (rows.length === 0) throw new PresetParseError('文件为空');
  const document = parseBlock(rows, 0, 0);
  if (!Array.isArray(document.value)) throw new PresetParseError('顶层不是补丁数组');
  // 只有整份文件都被解析才认结果：结构异常时宁可整份跳过，也不返回半份预设。
  if (document.next !== rows.length) throw new PresetParseError('存在无法解析的剩余结构');
  const found: PresetDeclaration[] = [];
  for (const entry of document.value) {
    const direct = presetDeclaration(entry);
    if (direct !== null) found.push(direct);
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const insert = (entry as Record<string, unknown>).insert;
    if (!Array.isArray(insert)) continue;
    for (const inserted of insert) {
      const nested = presetDeclaration(inserted);
      if (nested !== null) found.push(nested);
    }
  }
  return found;
}

/** bundle 清单声明的补丁文件加上 presets 目录里的补丁文件；两者都必须落在安装目录内。 */
function presetPatchFiles(dshRoot: string, bundleDirectory: string): { file: string; relative: string }[] {
  const candidates: string[] = [];
  const manifestPath = join(bundleDirectory, 'package.json');
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dsh?: { bundle?: { patch?: unknown } } };
      const declared = manifest.dsh?.bundle?.patch;
      for (const entry of typeof declared === 'string' ? [declared] : Array.isArray(declared) ? declared : []) {
        if (typeof entry !== 'string' || !entry.trim().endsWith('.patch.yml')) continue;
        candidates.push(resolve(bundleDirectory, entry.trim()));
      }
    } catch { /* 清单读不出来时按目录枚举，不因此判定预设不可用。 */ }
  }
  const presetsDirectory = join(bundleDirectory, 'presets');
  if (existsSync(presetsDirectory)) {
    for (const entry of readdirSync(presetsDirectory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.patch.yml')) candidates.push(join(presetsDirectory, entry.name));
    }
  }
  const files: { file: string; relative: string }[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates.sort((left, right) => left.localeCompare(right))) {
    if (files.length >= maxPresetFiles) break;
    const suffix = relative(dshRoot, resolve(candidate));
    if (suffix === '' || suffix.startsWith('..') || isAbsolute(suffix) || seen.has(suffix)) continue;
    seen.add(suffix);
    if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
    // 符号链接必须仍然落在安装目录内，越界资产一律跳过。
    const real = realpathSync(candidate);
    const realSuffix = relative(dshRoot, real);
    if (realSuffix === '' || realSuffix.startsWith('..') || isAbsolute(realSuffix)) continue;
    files.push({ file: real, relative: suffix });
  }
  return files;
}

/**
 * 枚举本地 DSH 安装的 Agent 预设：只读 web-app bundle 的声明式补丁层，
 * 不启动 DSH CLI/profile、不联网、不调用模型；失败时返回空列表与可读原因。
 */
export function discoverDshPresets(options: DshPresetOptions): DshPresetCatalog {
  try {
    const { dshRoot } = checkDshInstallation(options.dshRoot);
    const files = presetPatchFiles(dshRoot, join(dshRoot, 'packages', 'bundle', 'web-app'));
    if (files.length === 0) {
      return { presets: [], warning: '当前 DSH 安装没有声明式预设补丁层（packages/bundle/web-app 下既无清单声明也无 presets/*.patch.yml）；请沿用内置的 standard、ptc、minimal、cordis。' };
    }
    const presets = new Map<string, DshCatalogPreset>();
    const skipped: string[] = [];
    for (const { file, relative: name } of files) {
      try {
        if (statSync(file).size > maxPresetBytes) throw new PresetParseError('文件超过 ' + Math.round(maxPresetBytes / 1024) + ' KB 上限');
        for (const declaration of declarationsIn(readFileSync(file, 'utf8'))) {
          if (presets.has(declaration.id)) continue;
          presets.set(declaration.id, {
            id: declaration.id, name: declaration.name, order: declaration.order ?? presets.size + 1,
            source: { kind: 'bundle', file: name },
          });
        }
      } catch (error) {
        skipped.push(name + '（' + (error instanceof Error ? error.message : '未知原因') + '）');
      }
    }
    const listed = [...presets.values()].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
    if (listed.length === 0) {
      const detail = skipped.length === 0 ? '补丁层里没有预设声明' : '有 ' + skipped.length + ' 个文件未能解析：' + skipped.join('；');
      return { presets: [], warning: '未能从本地 DSH 安装读出预设（' + detail + '）；请沿用内置的 standard、ptc、minimal、cordis。' };
    }
    const warning = presetScopeNotice + (skipped.length === 0 ? '' : ' 有 ' + skipped.length + ' 个文件未能解析：' + skipped.join('；') + '。');
    return { presets: listed, warning };
  } catch {
    return { presets: [], warning: presetFallback };
  }
}

