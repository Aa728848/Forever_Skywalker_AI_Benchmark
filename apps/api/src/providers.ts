import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  projectProviderRowId, projectProviderStorePath, providerProfileValue, readProjectProviderStore, validateProviderProfile,
  writeProjectProviderStore,
  type DshCatalogProvider, type DshModelCatalog, type ProviderFieldError, type ProviderProfile, type ProjectProviderStore,
} from '@fsa/evaluation';

/**
 * 网页「供应商」页签的后端：管理本项目自己的 pi-ai 供应商档案。
 *
 * 三条边界，与 docs/notes/implemented 的设计决定一一对应：
 * 1. 档案写进本项目拥有的 data/provider-profiles.json，**默认不改写用户的 DSH home**。
 *    唯一例外是显式调用、且带确认的 export-dsh：先备份、再写，并把将写入的内容
 *    返回供人核对。
 * 2. 密钥永不入库、永不回显。档案只存凭据引用名（apiKeyEnv）；本模块取到的密钥值
 *    只进服务端出网请求的头部，绝不进入任何响应正文、错误消息或列表视图。
 * 3. 「已配置 / 未配置」由环境变量或 DSH 凭据库的 refs **名字**决定，不由值决定。
 */

/** DSH 凭据库默认位置：只读它的 refs 名字；值仅在探测取键时按需取出且不外传。 */
export const defaultProviderCredentialsPath = join(homedir(), '.dsh', '.credentials.yaml');
/** 档案默认位置：与 @fsa/evaluation 的 projectProviderStorePath 同一基准。 */
export const defaultProviderStorePath = projectProviderStorePath;

/** 探测超时上限；不短于一个慢网关的首字节时间，也不让一次点击挂住界面。 */
export const providerProbeTimeoutMs = 15_000;
/** 探测响应上限：与 DSH discovery.ts 的 MAX_RESPONSE_BYTES 一致；超限拒绝而不是截断。 */
export const providerProbeMaxBytes = 4 * 1024 * 1024;
/** 一次探测最多采纳的模型数：网关目录动辄上千条，网页表单不需要更多。 */
export const providerProbeMaxModels = 2000;

export interface ProviderView {
  id: string;
  displayName: string | null;
  api: string;
  baseURL: string;
  compat: { thinkingFormat?: string } | null;
  models: {
    id: string;
    name: string | null;
    contextWindow: number | null;
    maxTokens: number | null;
    input: string[];
    reasoningEfforts: Record<string, string | null> | false | null;
  }[];
  /** 凭据引用名；null 表示该路由按不认证处理。 */
  apiKeyEnv: string | null;
  /** 引用名在环境变量或 DSH 凭据库里有非空值；永远只是布尔值，不是值本身。 */
  keyConfigured: boolean;
  /** project = 本项目档案（可编辑）；dsh-patch = DSH profile 补丁层（只读）。 */
  source: 'project' | 'dsh-patch';
}

export interface ProviderList {
  providers: ProviderView[];
  storePath: string;
  dshProfilePath: string;
  /** 每一份来源各自的读取结论：档案坏掉时这里如实说明，而不是让整个列表消失。 */
  sources: { project: string; dshPatch: string };
}

export interface ProviderProbeRequest {
  baseURL: string;
  api: string;
  /** 已解析的密钥值；只存在于本次出网请求，不进入任何返回值。 */
  apiKey: string | undefined;
  timeoutMs: number;
}
export interface ProviderProbeResult {
  models: { id: string; name?: string; contextWindow?: number; maxTokens?: number }[];
  protocol: 'listable' | 'not-listable';
  note: string;
}

export interface ProvidersOptions {
  /** 项目档案路径；测试指向临时目录，绝不写真实 data/。 */
  storePath?: string;
  /** DSH 凭据库路径；只读 refs 名字。测试指向临时目录。 */
  credentialsPath?: string;
  /** DSH profile 补丁层路径；export-dsh 的目标，也是列表里 dshProfilePath 的值。 */
  dshProfilePath?: string;
  /** 生效环境：用于「凭据引用名是否已配置」与探测取键。 */
  env?: () => NodeJS.ProcessEnv;
  /** 目录读取：返回本地 DSH 目录（含补丁层 provider），用于列出只读的 dsh-patch 供应商。 */
  catalog?: () => Promise<DshModelCatalog>;
  /** 出网探测实现；测试注入假实现或本地假端点，避免联网。 */
  probe?: (request: ProviderProbeRequest) => Promise<ProviderProbeResult>;
  /** 探测超时（毫秒）；测试可缩短。 */
  probeTimeoutMs?: number;
}

/** 路由层据此选择 HTTP 状态：400 请求不合法，404 没有这个东西，502 出网失败。 */
export class ProviderError extends Error {
  readonly status: 400 | 404 | 502;
  readonly errors: ProviderFieldError[];
  constructor(status: 400 | 404 | 502, message: string, errors: ProviderFieldError[] = []) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.errors = errors;
  }
}

/* ── 凭据引用名 → 已配置 / 未配置（永不暴露值） ──────────────────────────────
 * 与目录查询的守卫同一条边界：密钥只在**名字**这一层被观察。两个来源按 DSH 自己
 * 的解析顺序——进程环境优先，其次是 DSH 凭据库的 refs；两者都没有就是未配置。
 * 只扫 refs 段的键名，不解析 YAML、不读 records 段的密文与账户数据，
 * 不引入第二套 YAML 语义。
 */
function credentialRefNames(path: string): { names: Set<string>; issue: string | null } {
  const names = new Set<string>();
  if (!existsSync(path)) return { names, issue: null };
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch { return { names, issue: '无法读取 DSH 凭据库；凭据引用名按未配置处理。' }; }
  let inRefs = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^refs:\s*(?:#.*)?$/.test(line)) { inRefs = true; continue; }
    if (!inRefs) continue;
    if (/^\S/.test(line)) { inRefs = false; continue; }
    const match = /^[ \t]+([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line);
    if (match !== null) names.add(match[1]!);
  }
  return { names, issue: null };
}

/** 从凭据库取一个引用名的**值**；只在出网探测时调用，调用方保证它不落盘、不回显。 */
function credentialRefValue(path: string, name: string): string | undefined {
  if (!existsSync(path)) return undefined;
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return undefined; }
  let inRefs = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^refs:\s*(?:#.*)?$/.test(line)) { inRefs = true; continue; }
    if (!inRefs) continue;
    if (/^\S/.test(line)) { inRefs = false; continue; }
    const match = new RegExp('^[ \\t]+' + name + '\\s*:\\s*(.*)$').exec(line);
    if (match === null) continue;
    const value = match[1]!.trim().replace(/^['"]|['"]$/g, '');
    return value === '' ? undefined : value;
  }
  return undefined;
}

/** 凭据值：进程环境优先，其次 DSH 凭据库的 refs。 */
function resolveCredential(env: NodeJS.ProcessEnv, credentialsPath: string, name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  const fromEnvironment = env[name];
  if (typeof fromEnvironment === 'string' && fromEnvironment.trim() !== '') return fromEnvironment.trim();
  return credentialRefValue(credentialsPath, name);
}

/* ── 端点探测 ────────────────────────────────────────────────────────────────
 * 与 DSH 的 packages/llm/llm-pi-ai/src/discovery.ts 逐条对齐，包括它明确**拒绝**
 * 猜测的部分：
 * - 可读目录的协议只有 anthropic-messages / openai-completions / openai-responses；
 * - openai-* 用 bearer auth 打 GET {baseURL}/models；
 * - anthropic-messages 用 x-api-key + anthropic-version: 2023-06-01 打 {root}/v1/models，
 *   其中 root 去掉一个结尾的 /v1（网关文档两种写法并存）；
 * - 回复上限 4 MiB，超限**拒绝**而不是截断（截断后的目录不可解析）；
 * - 其余协议如实报「无法探测」，让用户手填，不猜响应字段。
 */
const listableProtocols = new Set(['anthropic-messages', 'openai-completions', 'openai-responses']);
const anthropicVersion = '2023-06-01';
const anthropicModelLimit = 1000;

export function providerListingUrl(baseURL: string, api: string): string {
  const base = baseURL.replace(/\/+$/, '');
  if (api !== 'anthropic-messages') return base + '/models';
  const root = base.endsWith('/v1') ? base.slice(0, -3) : base;
  return root + '/v1/models?limit=' + String(anthropicModelLimit);
}

const capacity = (...candidates: readonly unknown[]): number | undefined => {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate;
  }
  return undefined;
};
const label = (...candidates: readonly unknown[]): string | undefined => {
  for (const candidate of candidates) if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  return undefined;
};

/**
 * 读一个已支持的模型列表回复。data 数组优先于 models 字典（与 DSH 一致）；
 * models 字典用属性名作端点侧 id，嵌套 id 只在属性名为空时兜底。
 * 单条坏记录跳过而不是让整次探测失败；缺名字时回落到 id。
 */
export function readProviderListing(body: unknown): { id: string; name?: string; contextWindow?: number; maxTokens?: number }[] {
  const listing = body as { data?: unknown; models?: unknown } | null;
  const data = listing?.data;
  let listed: { key?: string; raw: unknown }[];
  if (Array.isArray(data)) listed = (data as unknown[]).map(raw => ({ raw }));
  else {
    const models = listing?.models;
    if (models === null || typeof models !== 'object' || Array.isArray(models)) {
      throw new ProviderError(502, '端点回复既没有 data 数组也没有 models 对象；请手工填写模型。');
    }
    listed = Object.entries(models as Record<string, unknown>)
      .filter(([, raw]) => raw !== null && typeof raw === 'object' && !Array.isArray(raw))
      .map(([key, raw]) => ({ key, raw }));
  }
  const models: { id: string; name?: string; contextWindow?: number; maxTokens?: number }[] = [];
  for (const { key, raw } of listed) {
    const entry = raw as Record<string, unknown> | null;
    const id = label(key, entry?.id);
    if (id === undefined) continue;
    const name = label(entry?.name, entry?.display_name, entry?.displayName);
    const limit = entry?.limit as { context?: unknown; output?: unknown } | null | undefined;
    const topProvider = entry?.top_provider as { max_completion_tokens?: unknown } | null | undefined;
    const contextWindow = capacity(entry?.contextWindow, entry?.context_window, entry?.context_length, entry?.max_input_tokens, limit?.context);
    const maxTokens = capacity(entry?.maxOutputTokens, entry?.max_output_tokens, entry?.maxTokens, entry?.max_tokens, limit?.output, topProvider?.max_completion_tokens);
    models.push({ id, ...(name === undefined ? {} : { name }), ...(contextWindow === undefined ? {} : { contextWindow }), ...(maxTokens === undefined ? {} : { maxTokens }) });
  }
  return models;
}

/** 有界读取：先看声明的 content-length，再按实际读到的字节数累计；超限即取消并拒绝。 */
async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > providerProbeMaxBytes) {
    await response.body?.cancel();
    throw new ProviderError(502, '端点回复超过 4 MiB 上限，请改用支持分页的目录地址或手工填写模型。');
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > providerProbeMaxBytes) throw new ProviderError(502, '端点回复超过 4 MiB 上限，请改用支持分页的目录地址或手工填写模型。');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => { /* 读完后取消只是清理，结论已经定了。 */ });
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

/**
 * 出网探测一个端点。**本模块唯一发起网络请求的地方**，也是全项目唯一允许出网的
 * 业务路由（评分核心 packages/{core,contracts,static,judge,runs} 不含网络调用）。
 *
 * 失败一律收敛成结构化原因：不回传带端点或密钥的原始异常，也绝不回传响应正文
 * （它可能回显请求头里的凭据）。
 */
export async function probeProviderEndpoint(request: ProviderProbeRequest): Promise<ProviderProbeResult> {
  if (!listableProtocols.has(request.api)) {
    return { models: [], protocol: 'not-listable', note: '协议 ' + request.api + ' 没有本版本能读的模型列表端点；请手工填写模型。' };
  }
  const url = providerListingUrl(request.baseURL, request.api);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (request.api === 'anthropic-messages') {
    headers['anthropic-version'] = anthropicVersion;
    if (request.apiKey !== undefined) headers['x-api-key'] = request.apiKey;
  } else if (request.apiKey !== undefined) {
    headers.authorization = 'Bearer ' + request.apiKey;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new ProviderError(502, '探测超时（超过 ' + String(Math.round(request.timeoutMs / 1000)) + ' 秒）；请检查端点是否可达。');
    throw new ProviderError(502, '无法连接端点（' + (error instanceof Error ? error.name : '未知原因') + '）；请检查地址与网络。');
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403 ? '；请检查凭据引用名对应的值是否有效' : '';
    throw new ProviderError(502, '端点返回 HTTP ' + String(response.status) + hint + '。');
  }
  const text = await readBounded(response);
  let body: unknown;
  try { body = JSON.parse(text); }
  catch { throw new ProviderError(502, '端点回复不是 JSON；请确认地址指向模型列表接口。'); }
  const all = readProviderListing(body);
  const models = all.slice(0, providerProbeMaxModels);
  if (models.length === 0) return { models: [], protocol: 'listable', note: '端点可读但没有列出任何模型；请确认地址是模型目录接口，或手工填写模型。' };
  const truncated = all.length > models.length ? '（端点列出 ' + String(all.length) + ' 个，仅采纳前 ' + String(providerProbeMaxModels) + ' 个）' : '';
  return { models, protocol: 'listable', note: '已从端点读取 ' + String(models.length) + ' 个模型' + truncated + '；凭据值未落盘、未回显。' };
}

/* ── 视图与变更 ───────────────────────────────────────────────────────────── */

/**
 * 一条 DSH 补丁层路由的只读视图。目录协议只带 id/name/models，因此协议与端点
 * 在这里如实留空，而不是猜一个看起来合理的默认值。
 */
function dshPatchView(provider: DshCatalogProvider): ProviderView {
  return {
    id: provider.id,
    displayName: provider.name === provider.id ? null : provider.name,
    api: '', baseURL: '', compat: null,
    models: provider.models.map(model => ({
      id: model.id, name: model.name === model.id ? null : model.name,
      contextWindow: null, maxTokens: null, input: [], reasoningEfforts: null,
    })),
    apiKeyEnv: null, keyConfigured: false, source: 'dsh-patch',
  };
}

function projectView(profile: ProviderProfile, keyConfigured: boolean): ProviderView {
  return {
    id: profile.id,
    displayName: profile.displayName ?? null,
    api: profile.api,
    baseURL: profile.baseURL,
    compat: profile.compat ?? null,
    models: profile.models.map(model => ({
      id: model.id,
      name: model.name ?? null,
      contextWindow: model.contextWindow ?? null,
      maxTokens: model.maxTokens ?? null,
      input: model.input === undefined ? [] : [...model.input],
      reasoningEfforts: model.reasoningEfforts === undefined ? null : model.reasoningEfforts,
    })),
    apiKeyEnv: profile.apiKeyEnv ?? null,
    keyConfigured,
    source: 'project',
  };
}

/**
 * 生成一件 DSH 补丁层片段：一条 insert + 一条按固定 id 配置，语义是
 * 「没有就插入、已有就覆盖」。固定行 id 让反复导出幂等，也不与 DSH 自己设置
 * 界面写下的行重名。正文用 JSON（YAML 1.2 的子集）缩进而成，因此不需要本项目
 * 引入 YAML 依赖，也不存在两套 YAML 语义。
 *
 * 已知取舍：覆盖式——同 id 的整块 config 会被替换，因此导出会盖掉**上一次导出**
 * 的内容；DSH 自己设置界面写的行 id 不同，不受影响。写入前备份原文件。
 */
export function dshPatchText(profile: ProviderProfile): string {
  const providers = { [profile.id]: providerProfileValue(profile) };
  const lines = JSON.stringify(providers, null, 2).split('\n');
  const body = lines.slice(1, -1).map(line => '      ' + line).join('\n');
  return [
    '# 由本项目「供应商」页签导出。这一行是覆盖式的：它按固定 id ' + projectProviderRowId,
    '# 配置整块 config.providers，同 id 的行会被替换；DSH 自己设置界面写的行 id 不同，不受影响。',
    '# 写入前原文件已备份为同目录 .backup-<时间戳>。',
    '- insert:',
    '    - id: ' + projectProviderRowId,
    "      name: '@deepseek-ai/dsh-llm-pi-ai'",
    '      config:',
    '        providers:',
    '          ' + profile.id + ':',
    body,
    '- id: ' + projectProviderRowId,
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '  config:',
    '    providers:',
    '      ' + profile.id + ':',
    body,
    '',
  ].join('\n');
}

export interface Providers {
  readonly storePath: string;
  readonly dshProfilePath: string;
  list(): Promise<ProviderList>;
  upsert(id: string, raw: unknown): { provider: ProviderView; changed: boolean };
  remove(id: string): { removed: boolean };
  /** 读一个项目供应商的档案投影；只读路由与导出共用。 */
  profile(id: string): ProviderProfile | null;
  probe(raw: unknown): Promise<ProviderProbeResult & { apiKeyEnv: string | null; keyConfigured: boolean }>;
  exportDsh(id: string, options: { confirm: boolean }): { profilePath: string; backupPath: string | null; content: string; written: boolean };
}

export function createProviders(options: ProvidersOptions = {}): Providers {
  const storePath = resolve(options.storePath ?? defaultProviderStorePath);
  const credentialsPath = resolve(options.credentialsPath ?? defaultProviderCredentialsPath);
  const env = options.env ?? ((): NodeJS.ProcessEnv => process.env);
  const probe = options.probe ?? probeProviderEndpoint;
  const probeTimeoutMs = options.probeTimeoutMs ?? providerProbeTimeoutMs;
  const dshProfilePath = resolve(options.dshProfilePath ?? join(homedir(), '.dsh', 'profiles', env().BENCH_DSH_PROFILE ?? 'sdk', 'cordis.patch.yml'));

  const read = (): { store: ProjectProviderStore; issues: string[]; refNames: Set<string>; refIssue: string | null } => {
    const { store, issues } = readProjectProviderStore(storePath);
    const refs = credentialRefNames(credentialsPath);
    return { store, issues, refNames: refs.names, refIssue: refs.issue };
  };

  const configured = (name: string | undefined, refNames: Set<string>): boolean => {
    if (name === undefined) return false;
    const fromEnvironment = env()[name];
    if (typeof fromEnvironment === 'string' && fromEnvironment.trim() !== '') return true;
    return refNames.has(name);
  };

  const list = async (): Promise<ProviderList> => {
    const { store, issues, refNames, refIssue } = read();
    const project = Object.values(store.providers).map(profile => projectView(profile, configured(profile.apiKeyEnv, refNames)));
    const declared = new Set(project.map(provider => provider.id));
    // 补丁层路由只用于展示来源：同名时项目档案胜出（项目档案是本网页能编辑的那一份）。
    let patch: ProviderView[] = [];
    let dshPatch = '未提供本地 DSH 目录；这里只列出本项目档案。';
    try {
      const catalog = options.catalog === undefined ? null : await options.catalog();
      if (catalog !== null) {
        patch = catalog.providers.filter(provider => !declared.has(provider.id)).map(dshPatchView);
        dshPatch = 'DSH profile 补丁层里的只读供应商；同名时以项目档案为准。列表不验证凭据、额度或远程可用性。';
      }
    } catch (error) {
      dshPatch = '读取本地 DSH 目录失败，未列出补丁层供应商：' + (error instanceof Error ? error.message : '未知原因');
    }
    return {
      providers: [...project, ...patch],
      storePath,
      dshProfilePath,
      sources: {
        project: issues.length === 0 ? '项目档案读取正常。' : '项目档案有 ' + String(issues.length) + ' 处未生效：' + issues.join('；'),
        dshPatch: (refIssue === null ? '' : refIssue + ' ') + dshPatch,
      },
    };
  };

  const profile = (id: string): ProviderProfile | null => read().store.providers[id] ?? null;

  const upsert = (id: string, raw: unknown): { provider: ProviderView; changed: boolean } => {
    const { profile: next, errors } = validateProviderProfile(id, raw);
    if (next === null) throw new ProviderError(400, '供应商档案未通过校验。', errors);
    const { store: current, refNames } = read();
    // 字典的键就是 DSH 的路由 ID：允许它与档案自述不一致，只会制造
    // 「网页上叫 A、作答时报 B」的隐蔽缺陷。
    const changed = JSON.stringify(current.providers[id] ?? null) !== JSON.stringify(next);
    if (changed) writeProjectProviderStore(storePath, { version: 1, providers: { ...current.providers, [id]: next } });
    return { provider: projectView(next, configured(next.apiKeyEnv, refNames)), changed };
  };

  const remove = (id: string): { removed: boolean } => {
    const { store: current } = read();
    if (current.providers[id] === undefined) throw new ProviderError(404, '档案里没有供应商 ' + id + '。');
    const providers = { ...current.providers };
    delete providers[id];
    writeProjectProviderStore(storePath, { version: 1, providers });
    return { removed: true };
  };

  const probeEndpoint = async (raw: unknown): Promise<ProviderProbeResult & { apiKeyEnv: string | null; keyConfigured: boolean }> => {
    const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const api = typeof body.api === 'string' ? body.api : 'openai-completions';
    // 复用档案校验器验端点与协议这两项（同一处规则），探测是草案动作，此时还没有模型。
    const { errors } = validateProviderProfile('probe', { api, baseURL: body.baseURL, models: [{ id: 'probe' }] });
    if (errors.length > 0) throw new ProviderError(400, '探测参数未通过校验。', errors);
    const named = typeof body.apiKeyEnv === 'string' ? body.apiKeyEnv.trim() : '';
    const apiKeyEnv = named === '' ? undefined : named;
    if (apiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
      throw new ProviderError(400, '探测参数未通过校验。', [{ field: 'apiKeyEnv', message: '凭据引用名只能是环境变量样式（字母或下划线开头，仅字母数字下划线）。' }]);
    }
    const { refNames } = read();
    const result = await probe({
      baseURL: (body.baseURL as string).trim(), api,
      apiKey: resolveCredential(env(), credentialsPath, apiKeyEnv), timeoutMs: probeTimeoutMs,
    });
    return { ...result, apiKeyEnv: apiKeyEnv ?? null, keyConfigured: configured(apiKeyEnv, refNames) };
  };

  const exportDsh = (id: string, exportOptions: { confirm: boolean }): { profilePath: string; backupPath: string | null; content: string; written: boolean } => {
    const current = profile(id);
    if (current === null) throw new ProviderError(404, '档案里没有供应商 ' + id + '；请先保存它。');
    const content = dshPatchText(current);
    // 未确认时只回传「将要写入的内容」，不碰用户的 DSH home。
    if (!exportOptions.confirm) return { profilePath: dshProfilePath, backupPath: null, content, written: false };
    // 目标不存在说明这台机器没有这个 profile：拒绝，而不是在用户 home 下凭空造一个半截 profile。
    if (!existsSync(dshProfilePath)) throw new ProviderError(400, 'DSH profile 补丁层不存在：' + dshProfilePath + '；请先在 DSH 里初始化该 profile。');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
    const backupPath = join(dirname(dshProfilePath), '.backup-' + stamp);
    copyFileSync(dshProfilePath, backupPath);
    mkdirSync(dirname(dshProfilePath), { recursive: true });
    writeFileSync(dshProfilePath, content, 'utf8');
    return { profilePath: dshProfilePath, backupPath, content, written: true };
  };

  return { storePath, dshProfilePath, list, upsert, remove, profile, probe: probeEndpoint, exportDsh };
}
