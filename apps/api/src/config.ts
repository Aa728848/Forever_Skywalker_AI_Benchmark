import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// apps/api 的 package.json 不在本阶段允许改动清单内，因此按仓库既有先例（apps/api/src/app.test.ts）直接相对导入包源码。
import { EnvironmentFileConflictError, maskedConfigView, readProjectEnvironment, saveProjectEnvironment, secretKeyPattern, validateConfigPatch, type ConfigFieldError, type MaskedConfigEntry, type ProjectEnvironmentSnapshot } from '../../../packages/config/src/index.ts';
import { discoverDshModels, discoverDshPresets } from '@fsa/evaluation';

/** 仓库根：apps/api/src/config.ts 上溯三层，与 apps/api/src/reports.ts 的 defaultReportsRoot 同一基准。 */
export const apiRepositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** 判定「非空」，与 @fsa/config 的 env-file merge() 及 config.ts present() 保持一致。 */
const present = (value: string | undefined): boolean => value !== undefined && value.trim() !== '';

const nameOf = (name: string): string => process.platform === 'win32' ? name.toUpperCase() : name;

/**
 * 本阶段网页可编排的配置键。每一项都对应一条会被后续操作真正读取的配置：
 * 作答侧的 BENCH_DSH_* 由 dshWorkspaceOptionsFromEnvironment 读取，BENCH_MEASURE_PERFORMANCE 由 @fsa/evaluation 读取；
 * 裁判侧的 BENCH_JUDGE_DSH_* 由 dshJudgeOptionsFromEnvironment 读取；
 * BENCH_DSH_REPORT_DIR 决定报告中心根，BENCH_SUBMISSIONS_DIR 决定提交入口。
 * BENCH_JUDGE_TOKEN 只允许写入，永不回显（命中 secretKeyPattern）。
 */
const writableKeys = {
  answerProvider: 'BENCH_DSH_PROVIDER',
  answerModel: 'BENCH_DSH_MODEL',
  answerPreset: 'BENCH_DSH_PRESETS',
  answerEffort: 'BENCH_DSH_REASONING_EFFORT',
  answerPermission: 'BENCH_DSH_WORKSPACE_PERMISSION',
  judgeProvider: 'BENCH_JUDGE_DSH_PROVIDER',
  judgeModel: 'BENCH_JUDGE_DSH_MODEL',
  judgeEffort: 'BENCH_JUDGE_DSH_REASONING_EFFORT',
  judgeMaxTokens: 'BENCH_JUDGE_DSH_MAX_TOKENS',
  judgeTimeout: 'BENCH_JUDGE_DSH_TIMEOUT_MS',
  judgePromptVersion: 'BENCH_JUDGE_PROMPT_VERSION',
  reportsRoot: 'BENCH_DSH_REPORT_DIR',
  submissionsRoot: 'BENCH_SUBMISSIONS_DIR',
  measurePerformance: 'BENCH_MEASURE_PERFORMANCE',
} as const;

export type WritableConfigKey = typeof writableKeys[keyof typeof writableKeys];

export const writableConfigKeys: readonly WritableConfigKey[] = Object.values(writableKeys);
const writableKeySet: ReadonlySet<string> = new Set<string>(writableConfigKeys);

/**
 * 不可网页编排的项：它们决定既有记录的物理位置或进程级执行链路的解释方式，
 * 改动需要重启或让历史记录看起来消失，因此只读展示并提示到 CLI 修改。
 */
const readOnlyKeyReasons: Readonly<Record<string, string>> = {
  BENCH_RUN_DIR: '既有运行记录的物理位置，保持启动时固定；改动会让历史记录看起来消失，请用 CLI 或环境变量修改后重启服务。',
  BENCH_DSH_ROOT: 'DSH 安装目录，属于进程级执行链路；请用 CLI 或环境变量修改后重启服务。',
  BENCH_DSH_HOME: 'DSH 配置目录，属于进程级执行链路；请用 CLI 或环境变量修改后重启服务。',
  BENCH_DSH_PROFILE: 'DSH profile 名称，属于进程级执行链路；请用 CLI 或环境变量修改后重启服务。',
  BENCH_IMAGE: '固定 Linux 镜像引用，属于执行环境身份；请用 CLI 或环境变量修改。',
  BENCH_IMAGE_DIGEST: '固定镜像摘要，属于执行环境身份；请用 CLI 或环境变量修改。',
  BENCH_PROFILE: '平台执行档案，决定既有记录口径；请用 CLI 或环境变量修改后重启服务。',
};

/**
 * 一个键是否允许通过网页写入：
 * - 命中只读清单的键永远不允许，附带原因；
 * - 可写清单内的普通字段允许；
 * - 密钥类键（secretKeyPattern）允许写入但永不回显（例如令牌轮换）。
 */
function writeRule(field: string): { writable: boolean; reason: string | null } {
  const key = nameOf(field);
  const readOnly = readOnlyKeyReasons[key];
  if (readOnly !== undefined) return { writable: false, reason: readOnly };
  if (writableKeySet.has(key) || secretKeyPattern.test(key)) return { writable: true, reason: null };
  return { writable: false, reason: '不在网页可配置清单内；本视图只如实展示，不代为提示如何修改。' };
}

export type ConfigEntryView = MaskedConfigEntry & {
  readonly key: string;
  readonly writable: boolean;
  /** 不可写的键在这里说明原因；可写键为 null。 */
  readonly readOnlyReason: string | null;
};

export interface ConfigView {
  readonly path: string;
  readonly entries: Record<string, ConfigEntryView>;
  readonly writableKeys: readonly WritableConfigKey[];
  /** 全量键顺序（Windows 上键名已大写）；前端据此稳定渲染。 */
  readonly order: readonly string[];
}

export interface ConfigPlan {
  /** 将被写入的普通字段；密钥字段不在这里，不进入任何响应正文。 */
  readonly fields: ReadonlyArray<{ field: string; value: string }>;
  /** 本次会写入的密钥键名。值永不出现，前端只显示「已填写」。 */
  readonly secrets: ReadonlyArray<{ field: string }>;
  /** 本次真的会被写入或新增的键名。 */
  readonly changedKeys: readonly string[];
}

export interface ConfigSaveResult {
  readonly view: ConfigView;
  readonly changedKeys: readonly string[];
}

export type ModelCatalogView = {
  readonly providers: Awaited<ReturnType<typeof discoverDshModels>>['providers'];
  readonly warning: string;
};

/**
 * 预设目录视图：与模型目录同源，但只读本地声明式 YAML，不做任何进程级探测。
 * 失败时保持空数组与可读原因，前端据此回退到内置预设。
 */
export type PresetCatalogView = {
  readonly presets: ReturnType<typeof discoverDshPresets>['presets'];
  readonly warning: string;
};

/** 校验失败：字段级错误由路由转成 400，绝不写入文件。 */
export class ConfigValidationError extends Error {
  readonly errors: readonly ConfigFieldError[];
  constructor(errors: readonly ConfigFieldError[]) {
    super('配置补丁未通过校验。');
    this.name = 'ConfigValidationError';
    this.errors = errors;
  }
}

export interface ConfigProviderOptions {
  /** 项目根：.env 所在目录。缺省用仓库根。 */
  root?: string;
  /** 继承环境；缺省 process.env。测试可注入以构造「被 OS 环境变量遮蔽」的场景。 */
  env?: NodeJS.ProcessEnv;
  /** 模型目录发现实现；缺省读取本地 DSH，不联网、不调用模型。 */
  discover?: typeof discoverDshModels;
  /** 预设目录发现实现；缺省读取本地 DSH 安装的声明式 YAML，不启动 DSH、不联网。 */
  discoverPresets?: typeof discoverDshPresets;
}

export interface ConfigProvider {
  /** 当前有效配置（.env 与继承环境按既有语义合并）；每次保存成功后重算。 */
  current(): NodeJS.ProcessEnv;
  /** 冻结一份当前配置快照，供任务创建时使用；返回副本，不会被后续保存改写。 */
  snapshot(): NodeJS.ProcessEnv;
  view(): ConfigView;
  /** 只读校验：返回字段级错误，不写文件。 */
  validate(patch: Record<string, string | undefined>): readonly ConfigFieldError[];
  plan(patch: Record<string, string | undefined>): ConfigPlan;
  save(patch: Record<string, string | undefined>): ConfigSaveResult;
  models(): Promise<ModelCatalogView>;
  /** 本地 DSH 声明的 Agent 预设；同步只读，失败时返回空数组与原因，不抛异常。 */
  presets(): PresetCatalogView;
}

/** 只保留 patch 中真实出现的键：undefined 表示「不设置」，与 readProjectEnvironment 的合并语义一致。 */
function definedPatch(patch: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(patch).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/**
 * 配置提供者：承载当前有效配置，统一处理 .env 快照、校验、写入与冲突。
 * 保存成功后立即重算 current()，因此 /api/health 与提交入口无需重启即可按新值工作。
 * 与 saveProjectEnvironment 的既有约定一致：本模块不隐式修改 process.env。
 */
export function createConfigProvider(options: ConfigProviderOptions = {}): ConfigProvider {
  const root = options.root ?? apiRepositoryRoot;
  const inherited = options.env ?? process.env;
  const discover = options.discover ?? discoverDshModels;
  const discoverPresets = options.discoverPresets ?? discoverDshPresets;
  let state: ProjectEnvironmentSnapshot = readProjectEnvironment(root, inherited);

  const current = (): NodeJS.ProcessEnv => state.effectiveEnv;

  const view = (): ConfigView => {
    const env = state.effectiveEnv;
    // maskedConfigView 的第一个参数是「OS/继承环境」，不是合并结果：它自己按 merge() 语义算 source 与 shadowed。
    const mask = maskedConfigView(state.inheritedEnv, state.fileValues);
    const entries: Record<string, ConfigEntryView> = {};
    const order: string[] = [];
    const add = (key: string): void => {
      const normalized = nameOf(key);
      if (order.includes(normalized)) return;
      order.push(normalized);
      const { writable, reason } = writeRule(normalized);
      const base: MaskedConfigEntry = mask[normalized] ?? { value: env[normalized] ?? '', source: 'file', shadowed: false };
      entries[normalized] = 'configured' in base
        ? { key: normalized, configured: base.configured, source: base.source, shadowed: base.shadowed, writable, readOnlyReason: reason }
        : { key: normalized, value: base.value, source: base.source, shadowed: base.shadowed, writable, readOnlyReason: reason };
    };
    for (const key of writableConfigKeys) add(key);
    for (const key of Object.keys(readOnlyKeyReasons)) add(key);
    // 密钥键（例如 BENCH_JUDGE_TOKEN / BENCH_RUN_TOKEN）也出现在视图里，但只给 configured。
    for (const key of Object.keys(mask)) if (secretKeyPattern.test(key)) add(key);
    return { path: state.path, entries, writableKeys: writableConfigKeys, order };
  };

  const plan = (patch: Record<string, string | undefined>): ConfigPlan => {
    const fields: Array<{ field: string; value: string }> = [];
    const secrets: Array<{ field: string }> = [];
    const changedKeys: string[] = [];
    for (const [field, value] of Object.entries(definedPatch(patch))) {
      // 空值不会写入任何东西（校验阶段已拒绝「清空既有非空值」），因此也不进待写清单。
      if (!present(value)) continue;
      changedKeys.push(field);
      if (secretKeyPattern.test(field)) secrets.push({ field });
      else fields.push({ field, value });
    }
    return { fields, secrets, changedKeys };
  };

  /**
   * 字段级校验。只读项先被拒绝：视图里标了 writable: false，写入路径也必须真的拒绝，
   * 否则「不可网页编排」只是提示而不是约束。
   */
  const validate = (patch: Record<string, string | undefined>): readonly ConfigFieldError[] => {
    const errors: ConfigFieldError[] = [];
    const env = current();
    for (const [field, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      const rule = writeRule(field);
      if (!rule.writable) { errors.push({ field, message: '该配置不能通过网页修改：' + rule.reason }); continue; }
      // 安全写入器只补空值/覆写为新的非空值，不接受「清空」：空字符串在这里明确报错，而不是静默跳过。
      if (value.trim() === '' && present(env[nameOf(field)])) errors.push({ field, message: '不支持通过网页清空既有非空配置；请在 CLI 或 .env 中手动删除该行。' });
    }
    return errors.length > 0 ? errors : validateConfigPatch(env, patch, { baseDirectory: root });
  };

  const save = (patch: Record<string, string | undefined>): ConfigSaveResult => {
    const errors = validate(patch);
    if (errors.length > 0) throw new ConfigValidationError(errors);
    const defined = definedPatch(patch);
    if (Object.keys(defined).length === 0) return { view: view(), changedKeys: [] };
    // replace 只放本次 patch 里真实出现的键：其余键、注释、CRLF 与未知字段保持原样。
    state = saveProjectEnvironment(root, defined, state, { replace: Object.keys(defined) });
    return { view: view(), changedKeys: plan(patch).changedKeys };
  };

  /** 目录发现共用的本地路径：与 /api/health 之外的既有默认值一致。 */
  const dshLocations = (): { dshRoot: string; dshHome: string; profile: string } => {
    const env = current();
    return {
      dshRoot: resolve(env.BENCH_DSH_ROOT || join(homedir(), 'Documents', 'deepseek-harness')),
      dshHome: resolve(env.BENCH_DSH_HOME || env.DSH_HOME || join(homedir(), '.dsh')),
      profile: env.BENCH_DSH_PROFILE || 'sdk',
    };
  };

  const models = async (): Promise<ModelCatalogView> => {
    const { dshRoot, dshHome, profile } = dshLocations();
    const catalog = await discover({ dshRoot, dshHome, profile });
    return { providers: catalog.providers, warning: catalog.warning ?? '目录来自本地 DSH 配置；列表不验证凭据、额度或远程可用性。' };
  };

  const presets = (): PresetCatalogView => {
    // discoverDshPresets 自己吞掉所有失败并给出原因；这里再兜一层，保证路由永不因它 500。
    try {
      const catalog = discoverPresets({ dshRoot: dshLocations().dshRoot });
      return { presets: catalog.presets, warning: catalog.warning ?? '预设来自本地 DSH 声明式 YAML；列表不验证该预设能否在本机装载。' };
    } catch (error) {
      return { presets: [], warning: '无法读取本地 DSH 预设目录：' + (error instanceof Error ? error.message : '未知原因') + '；请沿用内置的 standard、ptc、minimal、cordis。' };
    }
  };

  return { current, snapshot: () => ({ ...current() }), view, validate, plan, save, models, presets };
}

// 冲突类型再从本模块导出一次：路由层只需要 apps/api/src/config.ts 这一个导入来源。
export { EnvironmentFileConflictError };
export type { ConfigFieldError, MaskedConfigEntry, ProjectEnvironmentSnapshot };
