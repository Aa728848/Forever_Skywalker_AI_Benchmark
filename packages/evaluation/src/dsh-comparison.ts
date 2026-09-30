import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { requireTask } from '@fsa/catalog';
import type { RunStatus } from '@fsa/contracts';
import { readRunStatus, verifySubmission } from '@fsa/executor';
import { createEnvelope, createRunStore, digestTree, type RunStore } from '@fsa/runs';
import { exportWorkspace } from '@fsa/tasks';
import { createQualityProvider } from './index.ts';
import { DshCleanupError, resolveDshWorkspacePermission, runDsh, type DshPreset, type DshRunOptions, type DshRunResult, type DshWorkspacePermission } from './dsh.ts';
import { inspectRunSelection, summarizeRuns } from './suite.ts';
import { archiveComparisonEvidence, cleanupComparisonScratch, createComparisonScratch, restoreComparisonEvidence } from './comparison-artifacts.ts';

export const comparisonPrompt = '阅读当前目录的 TASK.md，按照其中的契约完成 starter 中的代码修改。遵守修改范围，运行公开测试，完成后说明修改内容和测试结果。独立完成本次任务，不读取其它作答、评测仓库、隐藏检查或参考答案。本任务仅在当前工作区内进行：可以自由读写工作区、运行构建与测试所需的外部程序（node、dotnet、浏览器等），但不得访问或检索本评测项目的任何资产，包括工作区之外的参考答案、隐藏检查、评分脚本与本项目仓库；也不得联网检索本评测项目或其来源仓库。';

export interface DshComparisonOptions {
  dshRoot: string;
  dshHome: string;
  profile: string;
  workspacePermission: DshWorkspacePermission;
  provider: string;
  model: string;
  presets: DshPreset[];
  modes: string[];
  taskIds: string[];
  repeats: number;
  maxTokens: number;
  timeoutMs: number;
  outputDirectory: string;
  image: string;
  imageDigest: string;
  measurePerformance: boolean;
  /**
   * 续跑：在既有报告上只补跑**未完成**的行（phase 为 pending / error / solver-stopped），
   * 已完成的行连同分数原样保留。用于「55 题跑完 50 题、5 题未作答」的场景，
   * 避免为少数失败重付整轮模型额度。
   *
   * 开启时 `outputDirectory` 必须已有合格的 experiment.json；配置（供应商/模型/预设/
   * 等级/重复次数）必须与既有报告一致，否则拒绝——不同配置的分数不可合并。
   */
  resume?: boolean;
  /**
   * 同时推进的作答数（默认 1 = 既有串行行为）。
   *
   * 为什么值得开：一次 55 题实测里，作答只占 46%（120 分钟），其余 54% 是容器验证与
   * 两轮裁判会话；而主循环是逐个 row 串到底的，于是两者都不重叠。3 路可让作答、
   * 容器验证与裁判同时发生。
   *
   * 隔离前提（都已成立，不因并行而改变）：每题一个独立 workspace、一个唯一容器名
   * （fsa-<uuid>）、一个独立 DSH 会话、一个独立裁判实例（每题新建）。
   * 唯一需要额外处理的是共享的报告落盘与停止语义，见下方 persist/stop 的处理。
   */
  concurrency?: number;
}

export interface ComparisonEvaluation {
  status: RunStatus;
  environmentKey: string | null;
  judgeKey: string | null;
}

/**
 * 作答进行中的心跳：让只读出口能显示"已进行 N 分钟"，而不是在 solve() 阻塞的
 * 整段时间里只看到一个静止的 phase: 'solving'。
 *
 * 为什么需要：solve() 一次要跑满 20 分钟限时，期间不会调用 progress()，
 * 落盘的 experiment.json 因此十几分钟不变，网页每 5 秒轮询到的都是同一份快照——
 * 实测 k3 那轮 14:42:44 到 15:01:15 之间 mtime 纹丝不动，看起来像卡死。
 * 这个字段让"还在跑"和"已经死了"在页面上可区分。
 */
export interface ComparisonRowHeartbeat {
  /** 本条作答进入该阶段的时间。 */
  startedAt: string;
  /** 最近一次心跳时间；页面用它和当前时刻算出已耗时。 */
  at: string;
}

export interface ComparisonRow {
  taskId: string;
  taskVersion: string;
  preset: DshPreset;
  mode: string;
  repetition: number;
  sessionId: string;
  phase: 'pending' | 'solving' | 'grading' | 'done' | 'solver-stopped' | 'error';
  /** 仅在 phase 为 solving/grading 时非空；收尾阶段置 null。 */
  heartbeat: ComparisonRowHeartbeat | null;
  solver: DshRunResult | null;
  evaluation: ComparisonEvaluation | null;
  error: string | null;
}

export interface ComparisonProgress {
  at: string;
  message: string;
}

/**
 * DSH 会话 initialize 的等待上限，按并行度放大。
 *
 * DSH 默认 10 秒（sdk/client/src/launch.ts 的 DEFAULT_INITIALIZE_TIMEOUT_MS）是按
 * **单进程**启动估的。并行测评会同时拉起多个 DSH 进程，每个都要加载 profile、
 * 插件与适配器；实测 3 路并行时第 4 个会话正好在 10 秒处超时
 * （「initialize timed out after 10000ms waiting for dsh profile "sdk"」），
 * 那一次整轮 55 题只跑完 4 题就以 failed 结束。
 *
 * 作答与裁判都用它：两者都会并发启动 DSH 会话，放大的理由相同，
 * 因此这里是这一个事实的唯一归属。
 */
export function dshInitializeTimeoutMs(concurrency: number): number {
  // 基线给足冷启动，再按并发线性加一点；宁可可等待，也不要因启动慢丢掉一整题。
  return 30_000 + 15_000 * Math.max(1, concurrency);
}

/** 只保留最近 500 条进度，超出时丢弃最旧的，避免 experiment.json 随实验时长无界增长。 */
export const comparisonProgressLimit = 500;

/**
 * 作答/评分阶段的心跳落盘间隔（毫秒）。
 *
 * 取 5 秒是为了与网页的 5 秒轮询周期对齐：每次轮询都能看到跳动的心跳，
 * 页面上的"已进行 N 分钟"因此是连续增长的，而不是一跳一跳。
 */
export const heartbeatIntervalMs = 5000;

export function appendComparisonProgress(report: DshComparisonReport, message: string, at: string = new Date().toISOString()): void {
  report.progress.push({ at, message });
  if (report.progress.length > comparisonProgressLimit) report.progress.splice(0, report.progress.length - comparisonProgressLimit);
}

export interface DshComparisonReport {
  schemaVersion: '0.3.0';
  id: string;
  startedAt: string;
  finishedAt: string | null;
  state: 'running' | 'completed' | 'cancelled' | 'failed';
  settings: DshComparisonOptions;
  prompt: string;
  rows: ComparisonRow[];
  issues: string[];
  progress: ComparisonProgress[];
  evidence: { filename: string; sha256: string; fileCount: number } | null;
  cleanup: { state: 'pending' | 'complete' | 'retained'; directory: string | null; reason: string | null };
}

export interface ComparisonServices {
  solve?: (options: DshRunOptions) => Promise<DshRunResult>;
  evaluate?: (taskId: string, workspace: string, row: ComparisonRow, store: RunStore) => Promise<ComparisonEvaluation>;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  onProgress?: (message: string) => void;
}

export function validateComparison(options: DshComparisonOptions): void {
  if (!options.model.trim() || !options.provider.trim() || !options.profile.trim()) throw new Error('需要明确的 DSH 模型、供应商和 SDK profile。');
  resolveDshWorkspacePermission(options.workspacePermission);
  if (options.taskIds.length < 1 || options.taskIds.length > 55 || new Set(options.taskIds).size !== options.taskIds.length) throw new Error('请选择 1–55 道不重复的题目。');
  for (const id of options.taskIds) {
    if (requireTask(id).status === 'designed') throw new Error(`${id} 尚未具备题目包。`);
  }
  if (options.presets.length < 1 || options.presets.length > 4 || new Set(options.presets).size !== options.presets.length || options.presets.some(preset => !['standard', 'ptc', 'minimal', 'cordis'].includes(preset))) throw new Error('请选择不重复的 DSH 预设：standard、ptc、minimal、cordis。');
  if (options.modes.length < 1 || options.modes.length > 8 || new Set(options.modes).size !== options.modes.length || options.modes.some(mode => !/^[a-z][a-z0-9-]{0,31}$/.test(mode))) throw new Error('请选择 1–8 个不重复的推理等级标识。');
  if (!Number.isSafeInteger(options.repeats) || options.repeats < 1 || options.repeats > 20) throw new Error('重复次数须为 1–20。');
  if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1) throw new Error('每次请求输出上限须为正整数。');
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 86_400_000) throw new Error('每次作答时间上限须为 1 秒至 24 小时。');
  // 上限取 8：再多也只是把同一份模型配额摊得更碎，却让限流与容器争用显著上升。
  const concurrency = options.concurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('并行度须为 1–8 的整数。');
}

/** 缺测不补零，也不只挑完成作答计算均分。不同实际环境或裁判不合并。 */
export function comparisonGroups(report: DshComparisonReport) {
  const drift: string[] = [];
  for (const key of ['environmentKey', 'judgeKey'] as const) {
    const identities = new Set(report.rows.map(row => row.evaluation?.[key]).filter(value => value !== null && value !== undefined));
    if (identities.size > 1) drift.push(key === 'judgeKey' ? '裁判配置或实际模型不一致' : '执行环境不一致');
  }
  const versions = new Set(report.rows.flatMap(row => row.solver ? [row.solver.dshVersion] : []));
  const models = new Set(report.rows.flatMap(row => row.solver?.responseModels ?? []));
  if (versions.size > 1) drift.push('DSH 版本不一致');
  if (models.size > 1) drift.push('DSH 返回的作答模型不一致');
  for (const preset of report.settings.presets) {
    const fingerprints = new Set(report.rows.filter(row => row.preset === preset && row.solver).map(row => row.solver!.presetFingerprint));
    if (fingerprints.size > 1) drift.push(`DSH ${preset} 预设内容发生变化`);
  }
  return {
    drift,
    groups: report.settings.presets.flatMap(preset => report.settings.modes.flatMap(mode => (['core', 'integration'] as const).flatMap(track => {
      const rows = report.rows.filter(row => row.preset === preset && row.mode === mode && requireTask(row.taskId).track === track);
      if (rows.length === 0) return [];
      /**
       * 均分只统计**真正取到该分**的行，并把计入行数一并报出去。
       *
       * 旧实现只要有一行为 null 就把整组置成「待定」：miniMax 那轮 48 道核心题里 45 道都有分数，
       * 却因为 3 行评审证据缺失而整组显示待定——把 94% 的真实成绩藏了起来。
       * 反过来把缺失行当 0 参与平均同样不行（那是伪造分数）。
       * 因此：只对已有分数取平均 + 显式给出计入行数，让读者一眼看到覆盖率。
       * drift 非空时仍然拒绝合并——不同环境或裁判的分数不能混成一个均值。
       */
      const average = (dimension: 'functional' | 'quality' | 'total') => {
        const values = rows.map(row => row.evaluation?.status.scoring[dimension] ?? null);
        const scored = values.filter((value): value is number => value !== null);
        if (drift.length > 0 || scored.length === 0) return null;
        return Math.round(scored.reduce((sum, value) => sum + value, 0) / scored.length * 100) / 100;
      };
      const scoreCount = (dimension: 'functional' | 'quality' | 'total') =>
        rows.filter(row => (row.evaluation?.status.scoring[dimension] ?? null) !== null).length;
      return [{ preset, mode, track, planned: rows.length, completed: rows.filter(row => row.solver?.finishReason === 'completed').length,
        graded: rows.filter(row => row.evaluation !== null).length,
        passed: rows.filter(row => row.evaluation?.status.classification === 'passed').length,
        functional: average('functional'), quality: average('quality'), total: average('total'),
        functionalRows: scoreCount('functional'), qualityRows: scoreCount('quality'), totalRows: scoreCount('total') }];
    }))),
  };
}

export function renderComparison(report: DshComparisonReport): string {
  const { groups, drift } = comparisonGroups(report);
  const number = (value: number | null) => value === null ? '待定' : String(value);
  const cell = (value: string) => value.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
  return [
    '# DSH 模式对比', '',
    `实验：${report.id} · 状态：${report.state}`, '',
    `作答：${cell(report.settings.provider)} / ${cell(report.settings.model)} · DSH profile：${cell(report.settings.profile)}`,
    `工作区权限：${cell(report.settings.workspacePermission)}（每题独立工作区为边界）`,
    `每题 ${report.settings.repeats} 次；每次限时 ${report.settings.timeoutMs / 60_000} 分钟；每次模型请求输出上限 ${report.settings.maxTokens} Token（不是整题总预算）。`, '',
    ...report.settings.modes.includes('default') ? ['default 表示未向 DSH 指定思考等级，沿用供应商/模型配置；不等同于 off，也不代表已测得实际思考深度。', ''] : [],
    '以下为所选题目的试评均分，核心题与来源集成题的分级汇总另存；缺测不补分。', '',
    '| 赛道 | DSH 预设 | 思考等级 | 完成/计划 | 已评分 | 验证通过 | 可用均分 /50 | 质量均分 /50 | 总均分 /100 | 计入均分行数 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    // 均分只统计有分数的行：必须同时给出「计入行数/总行数」，否则读者会把部分覆盖误当成全量。
    ...groups.map(group => {
      const coverage = `总分 ${group.totalRows}/${group.planned} · 质量 ${group.qualityRows}/${group.planned}`;
      return `| ${group.track === 'core' ? '核心题' : '来源集成题'} | ${group.preset} | ${group.mode} | ${group.completed}/${group.planned} | ${group.graded} | ${group.passed} | ${number(group.functional)} | ${number(group.quality)} | ${number(group.total)} | ${coverage} |`;
    }), '',
    ...drift.map(issue => `对比无效：${issue}，已停止合并分数。`),
    ...report.issues.map(issue => `记录：${cell(issue)}`),
    ...report.rows.flatMap(row => {
      const status = row.evaluation?.status;
      if (status === undefined) return [];
      const refs = status.evidenceRefs.filter(ref => ref === 'review-error' || /^review-round-.+-error$/.test(ref));
      if (refs.length === 0) return [];
      const kept = status.evidenceRefs.filter(ref => /^review-round-\d+$/.test(ref));
      // 失败轮次与「有效轮次」必须同时说明：读者要能判断这份分数是几轮得出的。
      const used = kept.length > 0
        ? `本行质量分由 ${kept.map(ref => cell(ref)).join('、')} 的有效判决得出（共 ${kept.length} 轮）。`
        : '本行没有任何有效判决轮次，质量分与总分确实无法给出。';
      return [`待定原因：${row.taskId} 保留了未通过的评审轮次；失败轮的原始响应与字段路径见 ${refs.map(ref => cell(ref)).join('、')}（在 evidence.json.gz 内）。${used}`];
    }), '',
    '| 题目 | DSH 预设 | 思考等级 | 次数 | 作答结束原因 | 验证 | 作答秒数 | 分数 /100 | 运行/尝试 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.rows.map(row => `| ${row.taskId} ${row.taskVersion} | ${row.preset} | ${row.mode} | ${row.repetition} | ${cell(row.error ?? row.solver?.finishReason ?? row.phase)} | ${row.evaluation?.status.classification ?? '未评分'} | ${row.solver ? (row.solver.durationMs / 1000).toFixed(1) : '—'} | ${number(row.evaluation?.status.scoring.total ?? null)} | ${row.evaluation ? `${row.evaluation.status.runId}/${row.evaluation.status.attemptId}` : '—'} |`), '',
    '作答使用 DSH SDK 会话及明确选择的原始预设；新目录、新会话、固定提示和串行执行。',
    `证据：${report.evidence ? `[${report.evidence.filename}](${report.evidence.filename}) · SHA-256 ${report.evidence.sha256}` : '尚未归档'}。清理：${report.cleanup.state}${report.cleanup.directory ? `（临时目录 ${cell(report.cleanup.directory)}）` : ''}。`,
    '作答秒数含 DSH 启动与回收。usage 缺失保持 null；不根据文本长度估算 Token 或费用。DSH 路由不是供应商实际响应版本，后者未取得。运行时回收范围见每条 solver.cleanupScope；Linux 隔离用于评分。', '',
  ].join('\n');
}

/**
 * 改名并重试：Windows 上刚写完的文件仍可能被杀毒/索引程序短暂持有，
 * 此时 rename 会以 EPERM/EACCES/EBUSY 失败。这不是缺陷，重试即可通过。
 * 与 @fsa/runs 的 renameWithRetry 同策略——报告每次状态变更都落盘，一次瞬时占用
 * 就abort 整次实验的代价过大：实测 INT-HARNESS 因此把整轮 55 题判成 failed。
 */
function renameWithRetry(from: string, to: string): void {
  const delays = [0, 20, 50, 100, 200, 400];
  let lastError: unknown = null;
  for (const delay of delays) {
    if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    try { renameSync(from, to); return; }
    catch (error) {
      const code = (error as { code?: string }).code ?? '';
      if (!['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(code)) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('重命名报告文件失败。');
}

/**
 * 认领报告目录，保持「绝不覆盖既有实验」的语义。
 *
 * 调用方 `--experiment-id` 分支已经用 mkdirSync(recursive:false) 原子认领过该目录，
 * 因此这里必须区分两种情况：目录**不存在**时由本函数创建（普通 CLI 路径）；
 * 目录**已存在且为空**说明是调用方刚认领的，继续使用；
 * 目录已存在且**非空**才是有既有实验，拒绝覆盖。
 * 早期实现无条件 mkdirSync(recursive:false)，导致受控启动（网页发起）必然 EEXIST 退出。
 */
function claimOutputDirectory(directory: string): void {
  if (!existsSync(directory)) { mkdirSync(directory, { recursive: false }); return; }
  // 已存在：空目录视为调用方的认领，非空目录才是需要拒绝的既有实验。
  if (readdirSync(directory).length > 0) throw new Error(`报告目录已存在且非空，拒绝覆盖：${directory}`);
}

/** 续跑时与既有报告比对配置：这些字段不同就不能合并分数。 */
const resumableSettings = ['provider', 'model', 'presets', 'modes', 'taskIds', 'repeats'] as const;

/**
 * 一条行是否**真正落定**：续跑时原样保留，绝不重跑也不改分。
 *
 * 判据必须包含「拿到数值总分」，不能只看 phase === 'done'。
 * 实测证据（exp-2026-09-26T11-21-31-129Z-32e16e34）：GRAPH-04、STATE-01、STATE-03
 * 三条行的 phase 都是 'done'、evaluation 也不为 null，但 scoring.total 是 null
 * ——它们是「作答完成、评分待定」。只看 phase 会把它们当成已完成跳过，
 * 于是续跑永远修不好它们，待定就永久留在报告里。
 */
function isSettledRow(row: ComparisonRow): boolean {
  if (row.phase !== 'done') return false;
  const total = row.evaluation?.status?.scoring?.total;
  return typeof total === 'number' && Number.isFinite(total);
}

/**
 * 读取既有报告用于续跑，并核对配置一致。
 * 任何不一致都直接拒绝：把两套配置的分数混进一份报告，比不续跑更糟。
 */
function readResumableReport(directory: string, options: DshComparisonOptions): DshComparisonReport {
  const path = join(directory, 'experiment.json');
  if (!existsSync(path)) throw new Error('续跑要求报告目录里已有 experiment.json：' + directory);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error('既有 experiment.json 不是有效 JSON：' + (error instanceof Error ? error.message : String(error))); }
  const report = parsed as DshComparisonReport;
  if (report.schemaVersion !== '0.3.0' || !Array.isArray(report.rows)) throw new Error('既有 experiment.json 不是可续跑的 0.3.0 报告。');
  const previous = report.settings;
  for (const key of resumableSettings) {
    const before = JSON.stringify(previous?.[key]);
    const after = JSON.stringify(options[key]);
    if (before !== after) throw new Error('续跑配置与既有报告不一致（' + key + '）：报告是 ' + before + '，本次是 ' + after + '。请改用 --experiment-id 新建实验。');
  }
  return report;
}

/** 串行完成独立作答、冻结和验证；报告每次状态变更落盘，中断后不自动重做收费作答。 */
export async function runDshComparison(options: DshComparisonOptions, services: ComparisonServices = {}): Promise<DshComparisonReport> {
  validateComparison(options);
  // 续跑：复用既有报告的已完成行，只补跑未完成的那些。
  const resumed = options.resume === true ? readResumableReport(options.outputDirectory, options) : null;
  if (resumed === null) claimOutputDirectory(options.outputDirectory);
  const scratch = createComparisonScratch();
  // 续跑：先把既有证据解回本次 scratch，run store 才能看到被复用行的作答。
  // 少了这一步，末尾汇总会因为第一行复用行「未找到作答」而把整次续跑判 failed——
  // 即使 9 条目标全部修好、55/55 已落定。
  const restoredEvidence = resumed === null ? null : restoreComparisonEvidence(scratch, options.outputDirectory);
  const store = createRunStore(join(scratch.directory, 'evidence', 'runs'));
  const env = { ...(services.env ?? process.env) };
  // 裁判会话与作答会话一样会并发启动，因此 initialize 超时按同一规则放大。
  env.BENCH_JUDGE_DSH_INITIALIZE_TIMEOUT_MS = String(dshInitializeTimeoutMs(options.concurrency ?? 1));
  // 包含 CLI/向导已解析的覆盖值，保证作答与评分采用同一条非模型配置链。
  Object.assign(env, { BENCH_DSH_ROOT: options.dshRoot, BENCH_DSH_HOME: options.dshHome,
    BENCH_DSH_PROFILE: options.profile, BENCH_DSH_WORKSPACE_PERMISSION: options.workspacePermission });
  let judgeCleanupError: DshCleanupError | undefined;
  const qualityProvider = createQualityProvider({ env, measurePerformance: options.measurePerformance,
    onJudgeCleanupError(error) { judgeCleanupError = error; } });
  /**
   * 续跑时继承既有报告：保留 id、开始时间、已完成的行与全部进度，
   * 只把「未完成」的行重置为 pending 让它们重新排队。
   * 增量沿用同一份报告，因此历史行与分数一个字都不会变。
   */
  const report: DshComparisonReport = resumed === null
    ? { schemaVersion: '0.3.0', id: randomUUID(), startedAt: new Date().toISOString(), finishedAt: null,
        state: 'running', settings: { ...options }, prompt: comparisonPrompt, rows: [], issues: [], progress: [], evidence: null,
        cleanup: { state: 'pending', directory: scratch.directory, reason: null } }
    // rows 必须清空：下面会按本次配置重新生成全部行，再由 isSettledRow 把落定行替换回原对象。
    // 若沿用 resumed.rows，重新生成的行会追加到既有行之后，行数翻倍。
    : { ...resumed, rows: [], finishedAt: null, state: 'running', issues: [], evidence: null,
        settings: { ...resumed.settings, ...options },
        cleanup: { state: 'pending', directory: scratch.directory, reason: resumed.cleanup?.reason ?? null } };
  let cleanupAllowed = true;
  let retentionReason = '';
  // 按题配对，并在下一轮交换等级顺序，减少所有 A 都先于 B 的顺序影响。
  for (let repetition = 1; repetition <= options.repeats; repetition++) {
    for (const taskId of options.taskIds) {
      const combinations = options.presets.flatMap(preset => options.modes.map(mode => ({ preset, mode })));
      if (repetition % 2 === 0) combinations.reverse();
      for (const { preset, mode } of combinations) report.rows.push({ taskId, taskVersion: requireTask(taskId).version, preset, mode, repetition,
        sessionId: `bench-${randomUUID()}`, phase: 'pending', heartbeat: null, solver: null, evaluation: null, error: null });
    }
  }
  if (resumed !== null) {
    // 用既有报告里**已完成**的行覆盖刚生成的新行：按 (题目, 预设, 等级, 次数) 配对，
    // 已完成的保留原分数与 sessionId，未完成/出错的用新行重新排队。
    const settled = new Map<string, ComparisonRow>();
    for (const row of resumed.rows) if (isSettledRow(row)) {
      settled.set([row.taskId, row.preset, row.mode, row.repetition].join('|'), row);
    }
    const kept: ComparisonRow[] = [];
    const requeued: string[] = [];
    for (const fresh of report.rows) {
      const key = [fresh.taskId, fresh.preset, fresh.mode, fresh.repetition].join('|');
      const done = settled.get(key);
      if (done === undefined) { requeued.push(key); kept.push(fresh); continue; }
      kept.push(done);
    }
    report.rows.length = 0;
    report.rows.push(...kept);
    report.issues.push('本次为续跑：复用 ' + settled.size + ' 条已完成作答，重新执行 ' + requeued.length + ' 条未完成作答。');
  }
  // 只处理需要执行的行；已完成的行跳过，分数原样保留。
  const settledCount = report.rows.filter(isSettledRow).length;
  if (resumed !== null) report.issues.push('本次为续跑：复用 ' + settledCount + ' 行已完成结果，本次执行 ' + (report.rows.length - settledCount) + ' 行。');
  if (restoredEvidence !== null && restoredEvidence.fileCount > 0) report.issues.push('本次为续跑：已解回 ' + restoredEvidence.fileCount + ' 个既有证据文件，使历史作答的分数与证据在汇总时仍可读。');
  // 进度既交给调用方展示（CLI 打印行为不变），也作为只读出口的持久化记录。
  const progress = (message: string) => {
    appendComparisonProgress(report, message);
    persist();
    services.onProgress?.(message);
  };
  /**
   * 报告落盘。并行时多个 worker 会同时要求落盘，因此这里做两件事：
   *  1) 用唯一临时名——固定名 `experiment.json.tmp` 会被并发写互相覆盖；
   *  2) 用一条 Promise 链把落盘串起来——否则两次 rename 可能乱序，
   *     让较早的完整快照覆盖较新的那个。
   * 落盘内容始终是**当前这份 report** 的完整快照，所以谁最后写谁是对的。
   */
  let persistChain: Promise<void> = Promise.resolve();
  // 收尾后不再落盘：否则链上的任务会跑到 runDshComparison 返回之后，
  // 那时调用方（尤其是测试）可能已删掉输出目录，产生 ENOENT 未处理拒绝。
  let persistClosed = false;
  const persistNow = () => {
    const stamp = randomUUID();
    const jsonTemp = join(options.outputDirectory, 'experiment.json.' + stamp + '.tmp');
    const markdownTemp = join(options.outputDirectory, 'report.md.' + stamp + '.tmp');
    writeFileSync(jsonTemp, JSON.stringify(report, null, 2) + '\n');
    renameWithRetry(jsonTemp, join(options.outputDirectory, 'experiment.json'));
    // 与 experiment.json 相同的先写临时文件再改名：读者不会看到写了一半的 Markdown。
    writeFileSync(markdownTemp, renderComparison(report));
    renameWithRetry(markdownTemp, join(options.outputDirectory, 'report.md'));
  };
  /**
   * 落盘：串行排队，且**吞掉链上错误**——错误必须由 await 到的调用方看到，
   * 而不是变成未处理拒绝。persistClosed 之后调用直接成为空操作。
   */
  const persist = (): Promise<void> => {
    if (persistClosed) return Promise.resolve();
    persistChain = persistChain.then(persistNow, persistNow).catch(error => {
      // 记下来，交给下一次同步落盘或收尾抛出；不在这里抛，避免未处理拒绝。
      persistError = error instanceof Error ? error : new Error(String(error));
    });
    return persistChain;
  };
  /**
   * 等链排空（**不关闭**），并把链上的错误交给调用方。
   * 关闭是另一件事，只在真正返回前做一次——否则 finally 里写最终状态与 cleanup 的
   * persist() 会全部变成空操作，磁盘上的 state 会停在 'running'。
   */
  const drainPersist = async (): Promise<void> => {
    await persistChain;
    if (persistError !== null) { const error = persistError; persistError = null; throw error; }
  };
  let persistError: Error | null = null;
  const solve = services.solve ?? runDsh;
  const evaluate = services.evaluate ?? (async (taskId, workspace, row) => {
    const envelope = createEnvelope(taskId, workspace, { idempotencyKey: row.sessionId, reason: 'agent-completed' });
    const outcome = await verifySubmission({ store, taskId, envelope, candidateDirectory: workspace,
      submittedBy: `dsh:${options.provider}:${options.model}:${row.preset}:${row.mode}:r${row.repetition}`, profile: 'linux-container',
      image: options.image, imageDigest: options.imageDigest, qualityProvider,
      ...(services.signal ? { signal: services.signal } : {}) });
    const { runId, attemptId } = outcome.submission.attempt;
    const identity = inspectRunSelection(store, [{ runId, attemptId }]);
    return { status: readRunStatus(store, runId, attemptId), environmentKey: identity.environmentKey, judgeKey: identity.judgeKey };
  });
  /**
   * 停止派发：串行时一个 break 就够，并行时只能用标记让「还没开始的」行不再开始，
   * 在飞行的行必须收尾——否则它们的 workspace 与证据会半途而废。
   */
  let stopReason: 'cancelled' | 'failed' | null = null;
  const requestStop = (reason: 'cancelled' | 'failed') => { if (stopReason === null) stopReason = reason; };
  const shouldStop = () => stopReason !== null || services.signal?.aborted === true;

  const initializeTimeoutMs = dshInitializeTimeoutMs(options.concurrency ?? 1);

  /**
   * 心跳落盘：让阻塞中的阶段在只读出口上可见。
   *
   * 为什么需要定时器而不是 await 期间的循环：solve()/evaluate() 是一次不可打断的
   * await，只能靠外部定时器往 report 里写"还在跑"。间隔取 5 秒——与网页轮询周期对齐，
   * 保证每次轮询都能看到新心跳；同时远小于 20 分钟限时，磁盘写入量可忽略。
   *
   * 用 unref 让定时器不阻止进程退出；dispose() 清掉它并把 heartbeat 置 null，
   * 收尾阶段就不会留下一个已经停止跳动的"进行中"标记。
   */
  const startHeartbeat = (row: ComparisonRow): (() => void) => {
    const startedAt = new Date().toISOString();
    row.heartbeat = { startedAt, at: startedAt };
    const timer = setInterval(() => {
      if (row.heartbeat === null) return;
      row.heartbeat = { startedAt, at: new Date().toISOString() };
      persist();
    }, heartbeatIntervalMs);
    timer.unref?.();
    return () => { clearInterval(timer); row.heartbeat = null; };
  };

  /** 处理一条作答：作答 -> 容器验证 -> 裁判评分 -> 落盘。每条 row 只被一个 worker 处理。 */
  const runRow = async (row: ComparisonRow): Promise<void> => {
    const runtimeDirectory = join(scratch.directory, 'runtime', row.sessionId);
    const workspace = join(scratch.directory, 'workspaces', row.sessionId);
    let stopHeartbeat: (() => void) | null = null;
    try {
      exportWorkspace(row.taskId, workspace);
      row.phase = 'solving'; persist();
      progress(`${row.taskId} · ${row.preset} / ${row.mode} · 第 ${row.repetition} 次：DSH 作答中`);
      stopHeartbeat = startHeartbeat(row);
      row.solver = await solve({ dshRoot: options.dshRoot, dshHome: options.dshHome, profile: options.profile,
        agentPreset: row.preset, scratchDirectory: runtimeDirectory,
        workspacePermission: options.workspacePermission,
        workspace, provider: options.provider, model: options.model, reasoningEffort: row.mode,
        maxTokens: options.maxTokens, sessionId: row.sessionId, prompt: comparisonPrompt, timeoutMs: options.timeoutMs, env,
        initializeTimeoutMs,
        ...(services.signal ? { signal: services.signal } : {}) });
      stopHeartbeat(); stopHeartbeat = null;
      if (row.solver.finishReason !== 'completed') {
        // 取消：真的没有结论，保持未评分并停止派发。
        if (row.solver.finishReason === 'cancelled' || services.signal?.aborted) {
          row.phase = 'solver-stopped'; requestStop('cancelled'); return;
        }
        /**
         * 超时、内存超限、DSH 异常结束等**被测失败**：仍然走容器验证并记 0 分。
         *
         * 为什么不再跳过：跳过的行没有 evaluation，总分会保持待定——而「超时」
         * 本身就是一个明确的失败结论，不是「无法判断」。留作待定会让一次实验
         * 出现大量「待定」，用户看到的是一份没有成绩的报告。
         * 容器验证会把未取得的检查项按被测失败记 0（见 scoreExecution 的 timeout/
         * memory-exceeded 分支），所以这里只是让它走到那一步。
         */
        row.phase = 'grading'; persist();
        progress(`${row.taskId} · ${row.preset} / ${row.mode}：作答未完成（${row.solver.finishReason}），按 0 分验证`);
        stopHeartbeat = startHeartbeat(row);
        row.evaluation = await evaluate(row.taskId, workspace, row, store);
        stopHeartbeat(); stopHeartbeat = null;
        row.phase = 'done';
        return;
      }
      if (services.signal?.aborted) { row.phase = 'solver-stopped'; requestStop('cancelled'); return; }
      row.phase = 'grading'; persist();
      progress(`${row.taskId} · ${row.preset} / ${row.mode}：Linux 验证与评分中`);
      stopHeartbeat = startHeartbeat(row);
      row.evaluation = await evaluate(row.taskId, workspace, row, store);
      stopHeartbeat(); stopHeartbeat = null;
      if (judgeCleanupError) throw judgeCleanupError;
      row.phase = 'done';
      if (services.signal?.aborted) { requestStop('cancelled'); return; }
      /**
       * 基础设施故障（初始化超时、容器不可用等）：记在该行上并按 0 分收尾，**继续下一题**。
       *
       * 为什么不再中止整轮：一次 55 题实验里单题的基础设施抖动，不该让其余 54 题
       * 全部停在 pending——实测就是这样丢掉了一整轮（只跑完 4 题）。
       * 错误原因如实记在 row.error 与 reasons 里，不伪装成正常成绩。
       */
      if (row.evaluation.status.classification === 'infrastructure-error') {
        row.error = '评分基础设施失败：该题按 0 分计，继续后续作答。';
        progress(`${row.taskId} · ${row.preset} / ${row.mode}：基础设施失败，按 0 分计并继续`);
        return;
      }
      /**
       * 环境/模型漂移：**记录并继续**，不再中止整轮。
       *
       * 漂移意味着这些结果不可比——而 comparisonGroups 已经在汇总时拒绝合并
       * （drift 非空则各组均分返回 null，报告显示「待定」），诚实性不依赖中途停下。
       * 中止的代价却是丢掉其余全部作答（实测一次 55 题因此只剩 4 题）。
       * 因此改为逐次如实记录，跑到最后，由报告说明为什么不能合并。
       */
      const drift = comparisonGroups(report).drift;
      if (drift.length > 0) {
        const note = '环境或模型漂移：' + drift.join('；') + '。分数不合并，继续完成其余作答。';
        if (!report.issues.includes(note)) { report.issues.push(note); progress(note); }
      }
    } catch (error) {
      /**
       * 单题失败不再中止整轮。
       *
       * 例外只有两类，它们说明**后续作答不可能正确**或**环境已被破坏**，必须停下：
       *  · 取消：操作者要求停止；
       *  · DSH 运行时回收未确认（DshCleanupError）：临时目录与进程状态已不可信；
       *  · 环境/模型漂移：后续结果与前面的不可比。
       * 其余（初始化超时、容器故障、单题异常）都记为该题失败并继续。
       */
      if (error instanceof DshCleanupError) { cleanupAllowed = false; retentionReason = error.message; row.phase = 'error';
        row.error = error.message; requestStop('failed'); throw error; }
      const message = error instanceof Error ? error.message : String(error);
      if (/漂移/.test(message)) { row.phase = 'error'; row.error = message; requestStop('failed'); throw error; }
      row.phase = 'error'; row.error = message;
      progress(`${row.taskId} · ${row.preset} / ${row.mode}：该题失败（${message.slice(0, 80)}），已跳过并继续`);
    } finally {
      // 兜底停表：异常路径（取消、漂移、单题失败）不会走到上面那两处 stopHeartbeat。
      // 定时器必须在这里清掉，否则它会一直持有 row 引用并让 unref 失效前的进程不退出。
      stopHeartbeat?.();
      // 失败作答也保留代码证据；只有报告成功落盘后才删除工作副本。
      if (cleanupAllowed && existsSync(workspace)) {
        try {
          const digest = digestTree(workspace);
          const answerRoot = join(scratch.directory, 'evidence', 'answers', row.sessionId);
          mkdirSync(answerRoot, { recursive: true });
          for (const file of digest.files) {
            const target = join(answerRoot, file.path);
            mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(workspace, file.path), target);
          }
          if (digestTree(answerRoot).treeHash !== digest.treeHash) throw new Error('作答证据复制时发生变化。');
        } catch (error) {
          cleanupAllowed = false; retentionReason = '作答证据保存失败，保留临时目录。';
          throw error;
        }
      }
      persist();
    }
  };

  try {
    await persist();
    // 待执行的行（续跑复用的已落定行不在此列）。
    const queue = report.rows.filter(row => !(resumed !== null && isSettledRow(row)));
    const concurrency = Math.min(options.concurrency ?? 1, Math.max(1, queue.length));
    if (concurrency > 1) progress('并行度 ' + concurrency + '：同时推进 ' + queue.length + ' 条作答。');
    let cursor = 0;
    /** 一个 worker：不断取下一行，直到队列取空或收到停止标记。 */
    const worker = async (): Promise<void> => {
      while (cursor < queue.length && !shouldStop()) {
        const row = queue[cursor]!;
        cursor += 1;
        await runRow(row);
      }
    };
    // Promise.all 让第一条失败的 worker 立即冒泡；其余 worker 因 shouldStop() 不再取新行。
    // 在飞行的行仍会收尾（runRow 内部的 finally 必须跑完），因此不会留下半截证据。
    const results = await Promise.allSettled(Array.from({ length: concurrency }, () => worker()));
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected !== undefined && rejected.status === 'rejected') throw rejected.reason;
    if (stopReason === 'cancelled' || services.signal?.aborted) report.state = 'cancelled';
    else if (stopReason === 'failed') report.state = 'failed';
    if (report.state === 'running') report.state = 'completed';
    // 每模式/每次重复单独选择，沿用原分级门槛与集成题单列规则。
    if (services.evaluate === undefined) {
      const summariesRoot = join(scratch.directory, 'evidence', 'summaries');
      mkdirSync(summariesRoot, { recursive: true });
      for (const preset of options.presets) for (const mode of options.modes) for (let repetition = 1; repetition <= options.repeats; repetition++) {
        const selection = report.rows.filter(row => row.preset === preset && row.mode === mode && row.repetition === repetition && row.evaluation)
          .map(row => ({ runId: row.evaluation!.status.runId, attemptId: row.evaluation!.status.attemptId }));
        writeFileSync(join(summariesRoot, `${preset}-${mode}-r${repetition}-selection.json`), JSON.stringify(selection, null, 2) + '\n');
        if (selection.length > 0) writeFileSync(join(summariesRoot, `${preset}-${mode}-r${repetition}-summary.json`), JSON.stringify(summarizeRuns(store, selection), null, 2) + '\n');
      }
    }
    // 返回前排空落盘链：之后 persist 变成空操作，避免写入跑到调用方清理之后。
    await drainPersist();
  } catch (error) {
    report.state = services.signal?.aborted ? 'cancelled' : 'failed';
    report.issues.push(error instanceof Error ? error.message : String(error));
    // 失败路径同样排空：在途写入必须先落完，再进 finally 归档与清理。
    await drainPersist().catch(() => undefined);
  } finally {
    report.finishedAt = new Date().toISOString();
    try {
      report.evidence = archiveComparisonEvidence(scratch, options.outputDirectory, { merge: resumed !== null });
      await persist();
      if (!cleanupAllowed) throw new Error(retentionReason || '运行数据尚不能安全清理，保留临时目录。');
      cleanupComparisonScratch(scratch);
      report.cleanup = { state: 'complete', directory: null, reason: null };
      await persist();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.state = 'failed'; report.issues.push(message);
      if (existsSync(scratch.directory)) report.cleanup = { state: 'retained', directory: scratch.directory, reason: message };
      try { await persist(); } catch { throw new Error(`报告写入失败：${message}。保留的运行数据：${report.cleanup.directory ?? options.outputDirectory}`); }
    }
    // 最后一次排空 + 关闭：确保返回时没有任何在途写入，调用方随后清理目录才安全。
    await drainPersist().catch(() => undefined);
    persistClosed = true;
  }
  return report;
}