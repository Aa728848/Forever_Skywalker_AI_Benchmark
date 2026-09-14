import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const dshPresetLabels = { standard: '标准', ptc: 'PTC', minimal: '极简', cordis: '创造' } as const;
export type DshPreset = keyof typeof dshPresetLabels;

export function resolveDshPreset(value: string): DshPreset {
  const normalized = value.trim().toLowerCase().replace(/模式$/, '').trim();
  for (const [id, label] of Object.entries(dshPresetLabels)) {
    if (normalized === id || normalized === label.toLowerCase()) return id as DshPreset;
  }
  throw new Error('DSH 模式必须是 standard/标准、ptc/PTC、minimal/极简、cordis/创造。');
}

export interface DshRunOptions {
  dshRoot: string;
  dshHome: string;
  workspace: string;
  profile?: string;
  provider: string;
  model: string;
  reasoningEffort: string;
  agentPreset?: DshPreset;
  /** 本次作答的运行资料目录；调用方只能在 SDK close 确认后清理。 */
  scratchDirectory?: string;
  /** DSH 的每次模型请求输出上限，不是整题 Token 预算。 */
  maxTokens: number;
  sessionId: string;
  prompt: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export interface DshInstallation {
  dshRoot: string;
  sdkPath: string;
  cliPath: string;
  version: string;
}

export interface DshRunResult {
  finishReason: string;
  durationMs: number;
  finalResponse: string;
  /** 当前 SDK 未公开完整计费汇总；不能把可见消息的 usage 当成总费用。 */
  usage: null;
  /** null 表示未向 DSH 指定思考等级，沿用对应供应商/模型配置。 */
  requestedModel: { provider: string; model: string; reasoningEffort: string | null; maxTokens: number };
  requestedPreset: DshPreset;
  observedPresets: DshPreset[];
  presetFingerprint: string;
  /** SDK 消息归属的路由，不能当作供应商实际响应模型版本。 */
  observedRoutes: { provider: string; model: string }[];
  responseModels: string[];
  dshVersion: string;
  runtimeClosed: true;
  /** SDK close 只证明所拥有的运行时退出；强制退出不能证明脱离的工具进程均退出。 */
  cleanupScope: 'sdk-runtime';
}

interface DshEvent { type: string; data: Record<string, unknown> }
export interface DshNotification { method: string; params: Record<string, unknown> }
export interface DshHarness {
  /** SDK 高层 run 会略过首条 prompt 收件前的配置事件；独立订阅保留实际预设事实。 */
  client?: { subscribe(filter: (notification: DshNotification) => boolean): { tryNext(): DshNotification | undefined; close(): void } };
  run(prompt: string, options: { sessionId: string; onNotification: (notification: DshNotification) => void }): Promise<{
    finalResponse: string;
    events: DshEvent[];
  }>;
  close(): Promise<void>;
}
export interface DshLaunchOptions {
  dshBin: string;
  dshHome: string;
  processCwd: string;
  cwd: string;
  profile: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  maxTokens: number;
  patches: string[];
  env: NodeJS.ProcessEnv;
}
export interface DshDependencies {
  createHarness?: (options: DshLaunchOptions) => DshHarness;
}

export class DshCleanupError extends AggregateError {
  constructor(errors: unknown[], readonly scratchDirectory: string) {
    super(errors, `DSH 运行时回收未确认；停止后续作答并保留 ${scratchDirectory}。`);
    this.name = 'DshCleanupError';
  }
}

/** 仅校验显式安装目录，不启动 DSH、不发现用户目录、不读取凭据。 */
export function checkDshInstallation(dshRoot: string): DshInstallation {
  const root = realpathSync(dshRoot);
  const file = (path: string): string => {
    const absolute = realpathSync(join(root, path));
    const suffix = relative(root, absolute);
    if (suffix === '..' || suffix.startsWith('..\\') || suffix.startsWith('../') || isAbsolute(suffix) || !statSync(absolute).isFile()) {
      throw new Error(`DSH 安装文件必须位于指定目录内：${path}`);
    }
    return absolute;
  };
  const sdk = JSON.parse(readFileSync(file('packages/sdk/client/package.json'), 'utf8')) as { name?: string; version?: string };
  const cli = JSON.parse(readFileSync(file('apps/cli/package.json'), 'utf8')) as { name?: string; version?: string };
  if (sdk.name !== '@deepseek-ai/dsh-sdk-client' || cli.name !== '@deepseek-ai/dsh'
    || typeof sdk.version !== 'string' || sdk.version.length === 0 || sdk.version !== cli.version) {
    throw new Error('DSH 的 SDK 与 CLI 包身份或版本不一致，请完成同一版本的构建。');
  }
  return { dshRoot: root, sdkPath: file('packages/sdk/client/lib/index.js'), cliPath: file('apps/cli/lib/bin.js'), version: sdk.version };
}

function childEnvironment(env: NodeJS.ProcessEnv, dshHome: string): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const name = key.toUpperCase();
    if (!name.startsWith('BENCH_') && !['NODE_OPTIONS', 'NODE_PATH', 'DSH_HOME'].includes(name)) clean[key] = value;
  }
  clean.DSH_HOME = dshHome;
  clean.DSH_TELEMETRY_DISABLED = '1';
  return clean;
}

/** SDK 公开支持 launch patches；其 initialize 没有 agentPreset 参数。 */
function preparePreset(installation: DshInstallation, preset: DshPreset, scratch: string): { patch: string; fingerprint: string } {
  const source = (path: string): string => {
    const absolute = realpathSync(join(installation.dshRoot, path));
    const suffix = relative(installation.dshRoot, absolute);
    if (suffix.startsWith('..') || isAbsolute(suffix) || !statSync(absolute).isFile()) throw new Error(`DSH 预设资产越出安装目录：${path}`);
    return absolute;
  };
  const rosterModule = source('packages/preset/agent-presets/lib/index.js');
  const scopeModule = source('packages/core/scope/lib/index.js');
  const presetText = readFileSync(source(`packages/preset/agent-presets/presets/${preset}/agent.cordis.yml`), 'utf8');
  const web = readFileSync(source('packages/bundle/web-app/cordis.patch.yml'), 'utf8');
  const plane = web.split('# ── the agent plane moves behind agent presets')[1]?.split('# The preset roster.')[0];
  const disabled = [...(plane ?? '').matchAll(/^- id: ([a-z0-9-]+)\r?\n  disabled: true\r?$/gm)].map(match => match[1]!);
  if (disabled.length === 0) throw new Error('DSH 未提供可识别的 Agent 预设迁移配置；拒绝把 SDK 默认工具标为指定模式。');
  mkdirSync(scratch, { recursive: true });
  const bridge = join(scratch, 'preset-bridge.mjs');
  // 预装失败阻止 SDK readiness。同步绑定在首个 prompt 前完成；子 Agent 已由 DSH setup 继承时保留原绑定。
  writeFileSync(bridge, `import { createScope } from ${JSON.stringify(pathToFileURL(scopeModule).href)};
export const name = 'fsa-preset-bridge';
export const inject = ['agentPresets', 'subagentModelSelection', 'codeRuntime', 'dynamicCordisRunner'];
export async function apply(ctx) {
  const parent = createScope(ctx, {});
  ctx.effect(() => () => parent.dispose(), 'fsa.presetScope');
  await ctx.agentPresets.mount(parent.ctx, ${JSON.stringify(preset)});
  ctx.on('agent/created', ({ agent }) => {
    let actual = ctx.agentPresets.composedPreset(agent.ctx);
    if (actual === undefined) actual = ctx.agentPresets.composeFrom(agent.ctx, parent.ctx);
    if (actual !== ${JSON.stringify(preset)}) throw new Error('DSH Agent preset differs from the requested benchmark preset');
    if (agent.session.header.agentPreset === undefined) agent.session.append('agent-preset/selected', { agentPreset: actual });
  }, true);
  ctx.provide('fsaPresetReady', true);
}
`, { encoding: 'utf8', flag: 'wx' });
  const patch = join(scratch, 'launch.patch.json');
  writeFileSync(patch, JSON.stringify([
    ...disabled.map(id => ({ id, disabled: true })),
    { id: 'session-persistence-jsonl', config: { root: join(scratch, 'sessions') } },
    { id: 'storage-json', config: { root: join(scratch, 'storages') } },
    { id: 'attachment-local', config: { dshHome: join(scratch, 'attachments-home') } },
    { id: 'sdk-jsonrpc-server', inject: ['sdkAppStartup', 'loader', 'fsaPresetReady'], config: { maxTokensAsSuccess: false } },
    { insert: [
      { id: 'subagent-model-selection-settings', name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings' },
      { id: 'code-runtime', name: '@deepseek-ai/dsh-code-runtime-worker-thread' },
      { id: 'cordis-host-runner', name: '@deepseek-ai/dsh-cordis-host-runner' },
      { id: 'agent-presets', name: pathToFileURL(rosterModule).href, config: { default: preset, includeUserRoot: false, roots: [{ path: join(scratch, 'agent-presets'), trust: 'user' }] } },
      { id: 'fsa-preset-bridge', name: pathToFileURL(bridge).href },
    ] },
  ], null, 2), { encoding: 'utf8', flag: 'wx' });
  return { patch, fingerprint: createHash('sha256').update(presetText).update(plane!).digest('hex') };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanupOwnedScratch(scratch: string): void {
  const absolute = resolve(scratch);
  if (realpathSync(dirname(absolute)) !== realpathSync(tmpdir()) || !basename(absolute).startsWith('fsa-dsh-runtime-')
    || lstatSync(absolute).isSymbolicLink() || !lstatSync(absolute).isDirectory()) {
    throw new Error(`拒绝清理非本次 DSH 临时目录：${absolute}`);
  }
  rmSync(absolute, { recursive: true, force: true });
}

/** 一个独立会话的收题到 idle 区间；只认明确 completed，不将空闲误认作完成。 */
export async function runDsh(options: DshRunOptions, dependencies: DshDependencies = {}): Promise<DshRunResult> {
  for (const name of ['dshRoot', 'dshHome', 'workspace', 'provider', 'model', 'reasoningEffort', 'sessionId', 'prompt'] as const) {
    if (options[name].trim() === '') throw new Error(`DSH ${name} 不能为空。`);
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2_147_483_647
    || !Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0) throw new Error('DSH 超时与每请求输出 Token 上限必须是有效正整数。');
  options.signal?.throwIfAborted();
  const installation = checkDshInstallation(options.dshRoot);
  const workspace = realpathSync(options.workspace);
  if (!statSync(workspace).isDirectory()) throw new Error('DSH workspace 必须是目录。');
  const dshHome = resolve(options.dshHome);
  const preset = resolveDshPreset(options.agentPreset ?? 'standard');
  const ownScratch = options.scratchDirectory === undefined;
  const scratch = options.scratchDirectory === undefined ? mkdtempSync(join(tmpdir(), 'fsa-dsh-runtime-')) : resolve(options.scratchDirectory);
  let prepared: ReturnType<typeof preparePreset>;
  try { prepared = preparePreset(installation, preset, scratch); }
  catch (error) { if (ownScratch) cleanupOwnedScratch(scratch); throw error; }
  const launch: DshLaunchOptions = {
    dshBin: installation.cliPath, dshHome, processCwd: workspace, cwd: workspace,
    profile: options.profile ?? 'sdk', provider: options.provider, model: options.model,
    ...(options.reasoningEffort === 'default' ? {} : { reasoningEffort: options.reasoningEffort }), maxTokens: options.maxTokens,
    patches: [prepared.patch],
    env: childEnvironment(options.env ?? process.env, dshHome),
  };
  // 显式工厂用于不调用模型的协议/生命周期测试；生产只加载上述已验证的构建产物。
  let harness: DshHarness;
  try {
    const sdk = dependencies.createHarness ? undefined : await import(pathToFileURL(installation.sdkPath).href) as {
      DeepSeekHarness: new (options: DshLaunchOptions) => DshHarness;
    };
    harness = dependencies.createHarness ? dependencies.createHarness(launch) : new sdk!.DeepSeekHarness(launch);
  } catch (error) {
    if (ownScratch) cleanupOwnedScratch(scratch);
    throw error;
  }
  const started = performance.now();
  const events: DshEvent[] = [];
  const presetEvents: DshEvent[] = [];
  const presetSubscription = harness.client?.subscribe(notification => notification.method === 'session.event'
    && notification.params.sessionId === options.sessionId && record(notification.params.event) && notification.params.event.type === 'agent-preset/selected');
  let result: { finalResponse: string; events: DshEvent[] } | undefined;
  let interruption: 'timeout' | 'cancelled' | undefined;
  let failure: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    const stop = new Promise<void>(resolveStop => {
      cancel = () => { interruption = 'cancelled'; resolveStop(); };
      options.signal?.addEventListener('abort', cancel, { once: true });
      if (options.signal?.aborted) cancel();
      timer = setTimeout(() => { interruption = 'timeout'; resolveStop(); }, options.timeoutMs);
    });
    const work = Promise.resolve().then(async () => {
      if (interruption) return;
      result = await harness.run(options.prompt, {
        sessionId: options.sessionId,
        onNotification(notification) {
          if (notification.method !== 'session.event' || notification.params.sessionId !== options.sessionId) return;
          const event = notification.params.event;
          if (record(event) && typeof event.type === 'string' && record(event.data)) events.push({ type: event.type, data: event.data });
        },
      });
    });
    await Promise.race([work, stop]);
  } catch (error) { failure = error; }
  finally {
    clearTimeout(timer);
    if (cancel) options.signal?.removeEventListener('abort', cancel);
    try { await harness.close(); }
    catch (error) {
      throw new DshCleanupError(failure === undefined ? [error] : [failure, error], scratch);
    }
    if (presetSubscription) {
      for (let notification = presetSubscription.tryNext(); notification; notification = presetSubscription.tryNext()) {
        const event = notification.params.event;
        if (record(event) && typeof event.type === 'string' && record(event.data)) presetEvents.push({ type: event.type, data: event.data });
      }
      presetSubscription.close();
    }
    if (ownScratch) cleanupOwnedScratch(scratch);
  }
  if (failure !== undefined) throw failure;
  const settledEvents = result?.events ?? events;
  const end = settledEvents.filter(event => event.type === 'turn/end').at(-1);
  const reason = end?.data.reason;
  const observedPresets = [...new Set([...presetEvents, ...settledEvents].filter(event => event.type === 'agent-preset/selected')
    .map(event => event.data.agentPreset).filter((value): value is DshPreset => typeof value === 'string' && Object.hasOwn(dshPresetLabels, value)))];
  const confirmed = observedPresets.length === 1 && observedPresets[0] === preset;
  const observedRoutes = new Map<string, { provider: string; model: string }>();
  for (const event of settledEvents) {
    const message = event.type === 'assistant/message' ? event.data.message : undefined;
    const source = record(message) ? message.source : undefined;
    if (record(source) && typeof source.provider === 'string' && typeof source.model === 'string') {
      observedRoutes.set(JSON.stringify([source.provider, source.model]), { provider: source.provider, model: source.model });
    }
  }
  return {
    finishReason: interruption ?? (!confirmed ? 'preset-not-confirmed' : record(reason) && typeof reason.kind === 'string' ? reason.kind : 'missing-turn-end'),
    durationMs: Math.round(performance.now() - started), finalResponse: result?.finalResponse ?? '', usage: null,
    requestedModel: { provider: options.provider, model: options.model, reasoningEffort: launch.reasoningEffort ?? null, maxTokens: options.maxTokens },
    requestedPreset: preset, observedPresets, presetFingerprint: prepared.fingerprint,
    observedRoutes: [...observedRoutes.values()], responseModels: [], dshVersion: installation.version,
    runtimeClosed: true, cleanupScope: 'sdk-runtime',
  };
}
