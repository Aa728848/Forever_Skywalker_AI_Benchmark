import {
  assessmentValidator, difficulties, functionalWeights, qualityWeights, rubricVersion,
  type Assessment, type Difficulty, type ExecutionResult, type ExecutionScore, type ScoreResult, type Task, type TaskManifest,
} from '@fsa/contracts';

const round = (value: number) => Math.round(value * 100) / 100;

/** Evidence is caller supplied in M0. A valid preview is never an authenticated evaluation. */
export function parseAssessment(value: unknown): Assessment {
  if (!assessmentValidator.Check(value)) throw new Error('评分输入不符合 0.1.0 协议：分数须为 0–100 或 null，且字段必须完整。');
  const evidence = new Map(value.evidence.map(item => [item.id, item]));
  if (evidence.size !== value.evidence.length) throw new Error('证据 ID 不得重复。');
  if (new Set(value.criticalChecks.map(item => item.id)).size !== value.criticalChecks.length) throw new Error('关键检查 ID 不得重复。');
  const verifyRefs = (refs: string[], hasValue: boolean, kinds: string[]) => {
    if (hasValue && refs.length === 0) throw new Error('有分数或判定的检查必须引用证据。');
    for (const ref of refs) {
      const item = evidence.get(ref);
      if (!item || !kinds.includes(item.kind)) throw new Error(`证据引用不存在或类型不匹配：${ref}`);
    }
  };
  for (const item of Object.values(value.functional)) verifyRefs(item.evidence, item.score !== null, ['test', 'benchmark']);
  for (const [name, item] of Object.entries(value.quality)) {
    verifyRefs(item.objective.evidence, item.objective.score !== null, name === 'performance' ? ['benchmark'] : ['static']);
    verifyRefs(item.review.evidence, item.review.score !== null, ['review']);
  }
  for (const item of value.criticalChecks) verifyRefs(item.evidence, item.passed !== null, ['test', 'benchmark']);
  return value;
}

export function scoreAssessment(value: unknown): ScoreResult {
  const input = parseAssessment(value);
  let functional = 0;
  let functionalComplete = true;
  for (const [key, weight] of Object.entries(functionalWeights)) {
    const current = input.functional[key as keyof typeof functionalWeights].score;
    if (current === null) functionalComplete = false;
    else functional += current / 100 * weight;
  }
  const dimensions: ScoreResult['dimensions'] = { simplicity: null, maintainability: null, decoupling: null, performance: null };
  let quality = 0;
  let qualityComplete = true;
  for (const [key, weight] of Object.entries(qualityWeights)) {
    const name = key as keyof typeof qualityWeights;
    const { objective, review } = input.quality[name];
    if (objective.score === null || review.score === null) qualityComplete = false;
    else {
      const dimension = objective.score * weight + review.score * (1 - weight);
      dimensions[name] = round(dimension);
      quality += dimension / 100 * 12.5;
    }
  }
  const reasons: string[] = [];
  if (input.execution === 'infra-error') reasons.push('基础设施失败，等待同一快照重试。');
  if (input.execution === 'incomplete') reasons.push('执行证据尚未完成。');
  if (!functionalComplete) reasons.push('可用验证分项缺失。');
  if (!qualityComplete) reasons.push('代码客观指标或独立评审缺失。');
  if (input.criticalChecks.some(check => check.passed === null)) reasons.push('关键检查尚无结论。');
  const complete = reasons.length === 0;
  const total = functional + quality;
  const criticalPass = input.criticalChecks.every(check => check.passed === true);
  if (complete && !criticalPass) reasons.push('存在未通过的关键检查。');
  if (complete && functional < 40) reasons.push('可用验证低于 40/50。');
  if (complete && total < 70) reasons.push('总分低于 70/100。');
  return {
    mode: 'preview', rubricVersion,
    functional: functionalComplete ? round(functional) : null,
    quality: qualityComplete ? round(quality) : null,
    total: complete ? round(total) : null,
    dimensions,
    readiness: input.execution === 'infra-error' ? 'infra-error' : complete ? 'complete' : 'pending',
    // Compare unrounded values so display rounding cannot promote a failed attempt.
    thresholdMet: complete ? total >= 70 && functional >= 40 && criticalPass : null,
    reasons,
  };
}

export function summarizeLevels(
  tasks: ReadonlyArray<Pick<Task, 'id' | 'track' | 'difficulty'>>,
  reports: ReadonlyArray<{ taskId: string; result: ScoreResult }>,
) {
  const byId = new Map(reports.map(report => [report.taskId, report.result]));
  if (byId.size !== reports.length) throw new Error('同一题只能选择一次作答，禁止隐式挑选最高分。');
  if (reports.some(report => !tasks.some(task => task.id === report.taskId))) throw new Error('存在题库以外的报告。');
  const levels = difficulties.map(difficulty => {
    const expected = tasks.filter(task => task.track === 'core' && task.difficulty === difficulty);
    const completed = expected.flatMap(task => {
      const result = byId.get(task.id);
      return result?.total !== null && result?.total !== undefined ? [result] : [];
    });
    const complete = expected.length > 0 && completed.length === expected.length;
    const rawScore = complete ? completed.reduce((sum, result) => sum + (result.total ?? 0), 0) / expected.length : null;
    const passRate = complete ? completed.filter(result => result.thresholdMet).length / expected.length : null;
    return { difficulty, expected: expected.length, completed: completed.length, score: rawScore === null ? null : round(rawScore), passed: rawScore !== null && rawScore >= 70 && passRate !== null && passRate >= 0.8 };
  });
  let highestConsecutiveLevel: Difficulty | null = null;
  for (const level of levels) {
    if (!level.passed) break;
    highestConsecutiveLevel = level.difficulty;
  }
  const weightedTotal = levels.every(level => level.score !== null)
    ? round(levels.reduce((sum, level, index) => sum + (level.score ?? 0) * (index + 1) / 10, 0)) : null;
  return { mode: 'preview' as const, levels, weightedTotal, highestConsecutiveLevel };
}

/** 可用验证分组顺序固定；权重来自评分标准（20/10/10/5/5）。 */
const executionGroups = ['behavior', 'boundary', 'state', 'regression', 'resources'] as const;

/**
 * 正式评分：把受控执行结果换算成可用验证分项。
 * - 只接受执行器产出的检查状态；未取得的结论不能被 0 或满分替代。
 * - infrastructure-error 与 cancelled 属于未完成执行：可用分为 null，状态 pending。
 * - 被测失败（check-failed / timeout / memory-exceeded）按评分标准把相关项记 0。
 * - 代码质量四个维度没有静态/基准/评审证据时保持 null，因此总分待定。
 */

/** 质量维度输入：客观分（simplicity/maintainability/decoupling 用 static，performance 用 benchmark）与评审分。 */
export type QualityDimension = keyof typeof qualityWeights;

export interface QualityObjective {
  readonly score: number;
  readonly evidence: readonly string[];
  readonly kind: 'static' | 'benchmark';
}

export interface QualityReview {
  readonly score: number;
  readonly evidence: readonly string[];
}

export interface QualityEvidence {
  readonly objective?: Partial<Record<QualityDimension, QualityObjective>>;
  readonly review?: Partial<Record<QualityDimension, QualityReview>>;
}

const qualityDimensions = Object.keys(qualityWeights) as QualityDimension[];

/**
 * 质量维度合成：维度分 = 客观分 × 客观权重 + 评审分 ×（1 − 客观权重）。
 * 任一半缺失、或客观分证据类型不符（性能维度必须是 benchmark）时该维度保持 null，不做重新归一化。
 */
function composeQuality(evidence: QualityEvidence, reasons: string[]): { dimensions: Record<QualityDimension, number | null>; quality: number | null } {
  const dimensions: Record<QualityDimension, number | null> = { simplicity: null, maintainability: null, decoupling: null, performance: null };
  let total = 0;
  let complete = true;
  for (const key of qualityDimensions) {
    const objective = evidence.objective?.[key];
    const review = evidence.review?.[key];
    if (objective === undefined || review === undefined) {
      complete = false;
      if (objective !== undefined && objective.evidence.length === 0) reasons.push('质量维度 ' + key + ' 的客观分缺少证据引用。');
      if (review !== undefined && review.evidence.length === 0) reasons.push('质量维度 ' + key + ' 的评审分缺少证据引用。');
      continue;
    }
    const expected = key === 'performance' ? 'benchmark' : 'static';
    if (objective.kind !== expected) {
      complete = false;
      reasons.push('质量维度 ' + key + ' 的客观证据类型必须是 ' + expected + '，实际是 ' + objective.kind + '。');
      continue;
    }
    if (objective.evidence.length === 0 || review.evidence.length === 0) {
      complete = false;
      reasons.push('质量维度 ' + key + ' 的分数必须引用证据。');
      continue;
    }
    const weight = qualityWeights[key];
    const value = round(objective.score * weight + review.score * (1 - weight));
    dimensions[key] = value;
    total += (value / 100) * 12.5;
  }
  return { dimensions, quality: complete ? round(total) : null };
}
export function scoreExecution(execution: ExecutionResult, manifest: TaskManifest, evidence: QualityEvidence = {}): ExecutionScore {
  const statusOf = (id: string) => execution.checks.find(check => check.id === id)?.status ?? 'not-run';
  const undone = execution.classification === 'infrastructure-error' || execution.classification === 'cancelled';
  const groups = executionGroups.map(group => {
    const declared = manifest.checks.filter(check => check.group === group);
    const weightTotal = declared.reduce((sum, check) => sum + check.weight, 0);
    const passed = declared.filter(check => statusOf(check.id) === 'passed');
    const failed = declared.filter(check => statusOf(check.id) === 'failed');
    const notRun = declared.filter(check => statusOf(check.id) === 'not-run');
    const weightPassed = passed.reduce((sum, check) => sum + check.weight, 0);
    // 被测失败（含超时/OOM）按评分标准把未取得的项记 0；只有基础设施故障与取消才是“未取得结论”。
    const complete = !undone && weightTotal > 0;
    return {
      group,
      weight: functionalWeights[group],
      score: complete ? round((weightPassed / weightTotal) * 100) : null,
      weightPassed,
      weightTotal,
      passed: passed.map(check => check.id),
      failed: failed.map(check => check.id),
      notRun: notRun.map(check => check.id),
    };
  });
  const complete = groups.every(group => group.score !== null);
  const functional = complete
    ? round(groups.reduce((sum, group) => sum + ((group.score ?? 0) / 100) * group.weight, 0))
    : null;
  const criticalPassed = manifest.checks.filter(check => check.critical).every(check => statusOf(check.id) === 'passed');
  const reasons: string[] = [];
  if (execution.classification === 'infrastructure-error') reasons.push('基础设施故障：只允许同一快照有限重试，本次不产生分数。');
  if (execution.classification === 'cancelled') reasons.push('执行被取消：未取得结论，总分保持待定。');
  if (execution.classification === 'timeout') reasons.push('候选未在时间预算内完成：未取得的检查项按被测失败记 0。');
  if (execution.classification === 'memory-exceeded') reasons.push('候选因内存耗尽终止：未取得的检查项按被测失败记 0。');
  const notRunTotal = groups.reduce((sum, group) => sum + group.notRun.length, 0);
  if (!undone && notRunTotal > 0) reasons.push('仍有 ' + notRunTotal + ' 项检查未取得结论，按被测失败记 0。');
  if (!criticalPassed) reasons.push('存在未通过的关键验收项。');
  const composed = composeQuality(evidence, reasons);
  const total = functional !== null && composed.quality !== null ? round(functional + composed.quality) : null;
  if (composed.quality === null) {
    const missing = qualityDimensions.filter(key => composed.dimensions[key] === null);
    reasons.push('代码质量维度仍缺证据：' + missing.join('、') + '（客观分需要 static/benchmark 证据，评审分需要 review 证据），总分待定。');
  }
  const readiness: ExecutionScore['readiness'] = execution.classification === 'infrastructure-error' ? 'infra-error' : functional === null ? 'pending' : 'complete';
  return {
    schemaVersion: '0.1.0',
    mode: 'formal',
    rubricVersion,
    runId: execution.runId,
    attemptId: execution.attemptId,
    taskId: execution.taskId,
    taskVersion: execution.taskVersion,
    candidateTreeHash: execution.candidateTreeHash,
    classification: execution.classification,
    functional,
    quality: composed.quality,
    total,
    groups,
    dimensions: composed.dimensions,
    criticalPassed,
    readiness,
    // 总分已知时按「总分 ≥70、可用验证 ≥40、关键项全过」判定；证据不全时只保留关键项失败的确定结论。
    thresholdMet: total === null ? (criticalPassed ? null : false) : total >= 70 && (functional ?? 0) >= 40 && criticalPassed,
    reasons,
    evidenceRefs: execution.evidenceRefs,
    scoredAt: new Date().toISOString(),
  };
}
