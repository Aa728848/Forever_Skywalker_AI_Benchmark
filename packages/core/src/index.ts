import {
  assessmentValidator, difficulties, functionalWeights, qualityWeights, rubricVersion,
  type Assessment, type Difficulty, type ScoreResult, type Task,
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
