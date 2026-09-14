import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { requireTask } from '@fsa/catalog';
import type { RunStatus } from '@fsa/contracts';
import { readRunStatus, verifySubmission } from '@fsa/executor';
import { createEnvelope, createRunStore, digestTree, type RunStore } from '@fsa/runs';
import { exportWorkspace } from '@fsa/tasks';
import { createQualityProvider } from './index.ts';
import { DshCleanupError, runDsh, type DshPreset, type DshRunOptions, type DshRunResult } from './dsh.ts';
import { inspectRunSelection, summarizeRuns } from './suite.ts';
import { archiveComparisonEvidence, cleanupComparisonScratch, createComparisonScratch } from './comparison-artifacts.ts';

export const comparisonPrompt = '阅读当前目录的 TASK.md，按照其中的契约完成 starter 中的代码修改。遵守修改范围，运行公开测试，完成后说明修改内容和测试结果。独立完成本次任务，不读取其它作答、评测仓库、隐藏检查或参考答案。';

export interface DshComparisonOptions {
  dshRoot: string;
  dshHome: string;
  profile: string;
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
}

export interface ComparisonEvaluation {
  status: RunStatus;
  environmentKey: string | null;
  judgeKey: string | null;
}

export interface ComparisonRow {
  taskId: string;
  taskVersion: string;
  preset: DshPreset;
  mode: string;
  repetition: number;
  sessionId: string;
  phase: 'pending' | 'solving' | 'grading' | 'done' | 'solver-stopped' | 'error';
  solver: DshRunResult | null;
  evaluation: ComparisonEvaluation | null;
  error: string | null;
}

export interface DshComparisonReport {
  schemaVersion: '0.2.0';
  id: string;
  startedAt: string;
  finishedAt: string | null;
  state: 'running' | 'completed' | 'cancelled' | 'failed';
  settings: DshComparisonOptions;
  prompt: string;
  rows: ComparisonRow[];
  issues: string[];
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
  if (options.taskIds.length < 1 || options.taskIds.length > 55 || new Set(options.taskIds).size !== options.taskIds.length) throw new Error('请选择 1–55 道不重复的题目。');
  for (const id of options.taskIds) {
    if (requireTask(id).status === 'designed') throw new Error(`${id} 尚未具备题目包。`);
  }
  if (options.presets.length < 1 || options.presets.length > 4 || new Set(options.presets).size !== options.presets.length || options.presets.some(preset => !['standard', 'ptc', 'minimal', 'cordis'].includes(preset))) throw new Error('请选择不重复的 DSH 预设：standard、ptc、minimal、cordis。');
  if (options.modes.length < 1 || options.modes.length > 8 || new Set(options.modes).size !== options.modes.length || options.modes.some(mode => !/^[a-z][a-z0-9-]{0,31}$/.test(mode))) throw new Error('请选择 1–8 个不重复的推理等级标识。');
  if (!Number.isSafeInteger(options.repeats) || options.repeats < 1 || options.repeats > 20) throw new Error('重复次数须为 1–20。');
  if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1) throw new Error('每次请求输出上限须为正整数。');
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 86_400_000) throw new Error('每次作答时间上限须为 1 秒至 24 小时。');
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
      const average = (dimension: 'functional' | 'quality' | 'total') => {
        const values = rows.map(row => row.evaluation?.status.scoring[dimension] ?? null);
        if (drift.length > 0 || values.length === 0 || values.some(value => value === null)) return null;
        return Math.round(values.reduce<number>((sum, value) => sum + (value ?? 0), 0) / values.length * 100) / 100;
      };
      return [{ preset, mode, track, planned: rows.length, completed: rows.filter(row => row.solver?.finishReason === 'completed').length,
        graded: rows.filter(row => row.evaluation !== null).length,
        passed: rows.filter(row => row.evaluation?.status.classification === 'passed').length,
        functional: average('functional'), quality: average('quality'), total: average('total') }];
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
    `每题 ${report.settings.repeats} 次；每次限时 ${report.settings.timeoutMs / 60_000} 分钟；每次模型请求输出上限 ${report.settings.maxTokens} Token（不是整题总预算）。`, '',
    ...report.settings.modes.includes('default') ? ['default 表示未向 DSH 指定思考等级，沿用供应商/模型配置；不等同于 off，也不代表已测得实际思考深度。', ''] : [],
    '以下为所选题目的试评均分，核心题与来源集成题的分级汇总另存；缺测不补分。', '',
    '| 赛道 | DSH 预设 | 思考等级 | 完成/计划 | 已评分 | 验证通过 | 可用均分 /50 | 质量均分 /50 | 总均分 /100 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...groups.map(group => `| ${group.track === 'core' ? '核心题' : '来源集成题'} | ${group.preset} | ${group.mode} | ${group.completed}/${group.planned} | ${group.graded} | ${group.passed} | ${number(group.functional)} | ${number(group.quality)} | ${number(group.total)} |`), '',
    ...drift.map(issue => `对比无效：${issue}，已停止合并分数。`),
    ...report.issues.map(issue => `记录：${cell(issue)}`), '',
    '| 题目 | DSH 预设 | 思考等级 | 次数 | 作答结束原因 | 验证 | 作答秒数 | 分数 /100 | 运行/尝试 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.rows.map(row => `| ${row.taskId} ${row.taskVersion} | ${row.preset} | ${row.mode} | ${row.repetition} | ${cell(row.error ?? row.solver?.finishReason ?? row.phase)} | ${row.evaluation?.status.classification ?? '未评分'} | ${row.solver ? (row.solver.durationMs / 1000).toFixed(1) : '—'} | ${number(row.evaluation?.status.scoring.total ?? null)} | ${row.evaluation ? `${row.evaluation.status.runId}/${row.evaluation.status.attemptId}` : '—'} |`), '',
    '作答使用 DSH SDK 会话及明确选择的原始预设；新目录、新会话、固定提示和串行执行。',
    `证据：${report.evidence ? `[${report.evidence.filename}](${report.evidence.filename}) · SHA-256 ${report.evidence.sha256}` : '尚未归档'}。清理：${report.cleanup.state}${report.cleanup.directory ? `（临时目录 ${cell(report.cleanup.directory)}）` : ''}。`,
    '作答秒数含 DSH 启动与回收。usage 缺失保持 null；不根据文本长度估算 Token 或费用。DSH 路由不是供应商实际响应版本，后者未取得。运行时回收范围见每条 solver.cleanupScope；Linux 隔离用于评分。', '',
  ].join('\n');
}

/** 串行完成独立作答、冻结和验证；报告每次状态变更落盘，中断后不自动重做收费作答。 */
export async function runDshComparison(options: DshComparisonOptions, services: ComparisonServices = {}): Promise<DshComparisonReport> {
  validateComparison(options);
  mkdirSync(options.outputDirectory, { recursive: false });
  const scratch = createComparisonScratch();
  const store = createRunStore(join(scratch.directory, 'evidence', 'runs'));
  const env = { ...(services.env ?? process.env) };
  const qualityProvider = createQualityProvider({ env, measurePerformance: options.measurePerformance });
  const report: DshComparisonReport = { schemaVersion: '0.2.0', id: randomUUID(), startedAt: new Date().toISOString(), finishedAt: null,
    state: 'running', settings: { ...options }, prompt: comparisonPrompt, rows: [], issues: [], evidence: null,
    cleanup: { state: 'pending', directory: scratch.directory, reason: null } };
  let cleanupAllowed = true;
  let retentionReason = '';
  // 按题配对，并在下一轮交换等级顺序，减少所有 A 都先于 B 的顺序影响。
  for (let repetition = 1; repetition <= options.repeats; repetition++) {
    for (const taskId of options.taskIds) {
      const combinations = options.presets.flatMap(preset => options.modes.map(mode => ({ preset, mode })));
      if (repetition % 2 === 0) combinations.reverse();
      for (const { preset, mode } of combinations) report.rows.push({ taskId, taskVersion: requireTask(taskId).version, preset, mode, repetition,
        sessionId: `bench-${randomUUID()}`, phase: 'pending', solver: null, evaluation: null, error: null });
    }
  }
  const persist = () => {
    writeFileSync(join(options.outputDirectory, 'experiment.json.tmp'), JSON.stringify(report, null, 2) + '\n');
    renameSync(join(options.outputDirectory, 'experiment.json.tmp'), join(options.outputDirectory, 'experiment.json'));
    writeFileSync(join(options.outputDirectory, 'report.md'), renderComparison(report));
  };
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
  try {
    persist();
    for (const row of report.rows) {
      if (services.signal?.aborted) { report.state = 'cancelled'; break; }
      const runtimeDirectory = join(scratch.directory, 'runtime', row.sessionId);
      const workspace = join(scratch.directory, 'workspaces', row.sessionId);
      try {
        exportWorkspace(row.taskId, workspace);
        row.phase = 'solving'; persist();
        services.onProgress?.(`${row.taskId} · ${row.preset} / ${row.mode} · 第 ${row.repetition} 次：DSH 作答中`);
        row.solver = await solve({ dshRoot: options.dshRoot, dshHome: options.dshHome, profile: options.profile,
          agentPreset: row.preset, scratchDirectory: runtimeDirectory,
          workspace, provider: options.provider, model: options.model, reasoningEffort: row.mode,
          maxTokens: options.maxTokens, sessionId: row.sessionId, prompt: comparisonPrompt, timeoutMs: options.timeoutMs, env,
          ...(services.signal ? { signal: services.signal } : {}) });
        if (row.solver.finishReason !== 'completed') {
          row.phase = 'solver-stopped';
          if (row.solver.finishReason === 'cancelled' || services.signal?.aborted) { report.state = 'cancelled'; break; }
          continue;
        }
        if (services.signal?.aborted) { row.phase = 'solver-stopped'; report.state = 'cancelled'; break; }
        row.phase = 'grading'; persist();
        services.onProgress?.(`${row.taskId} · ${row.preset} / ${row.mode}：Linux 验证与评分中`);
        row.evaluation = await evaluate(row.taskId, workspace, row, store);
        row.phase = 'done';
        if (services.signal?.aborted) { report.state = 'cancelled'; break; }
        if (row.evaluation.status.classification === 'infrastructure-error') throw new Error('评分基础设施失败，已停止后续模型调用。');
        if (comparisonGroups(report).drift.length > 0) throw new Error('检测到环境或模型漂移，已停止后续作答。');
      } catch (error) {
        if (error instanceof DshCleanupError) { cleanupAllowed = false; retentionReason = error.message; }
        row.phase = 'error'; row.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
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
    }
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
  } catch (error) {
    report.state = services.signal?.aborted ? 'cancelled' : 'failed';
    report.issues.push(error instanceof Error ? error.message : String(error));
  } finally {
    report.finishedAt = new Date().toISOString();
    try {
      report.evidence = archiveComparisonEvidence(scratch, options.outputDirectory);
      persist();
      if (!cleanupAllowed) throw new Error(retentionReason || '运行数据尚不能安全清理，保留临时目录。');
      cleanupComparisonScratch(scratch);
      report.cleanup = { state: 'complete', directory: null, reason: null };
      persist();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.state = 'failed'; report.issues.push(message);
      if (existsSync(scratch.directory)) report.cleanup = { state: 'retained', directory: scratch.directory, reason: message };
      try { persist(); } catch { throw new Error(`报告写入失败：${message}。保留的运行数据：${report.cleanup.directory ?? options.outputDirectory}`); }
    }
  }
  return report;
}
