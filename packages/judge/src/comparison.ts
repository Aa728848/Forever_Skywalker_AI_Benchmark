import { qualityPointsPerDimension, qualityWeights, type ReviewVerdict } from '@fsa/contracts';
import { JudgeUnavailableError } from './index.ts';

/**
 * 合并两轮独立判决：两轮不同就取平均，**不再因为分歧而要求人工复核、把评审分整体作废**。
 *
 * 为什么改：原先任两维差异超过 20 分即 needsHumanReview，调用方随之丢弃两轮结果，
 * 质量分与总分一起待定。实测一次 12 题的真实作答里，LSP-01 因此成为唯一的「待定」——
 * 而它两轮都是有效判决（第 1 轮 100/100/100，第 2 轮 78/80/80）。用户明确要求：
 * 两次不同就采用平均值。平均值本身就是保守估计，不会凭空抬高分数。
 *
 * 差异仍然逐维记录下来（differences），供报告与人工复核参考，只是不再阻断评分。 */
export function compareReviews(first: ReviewVerdict, second: ReviewVerdict, functional: number | null = null) {
  if (first.runId !== second.runId || first.attemptId !== second.attemptId || first.taskId !== second.taskId
    || first.model !== second.model || first.promptVersion !== second.promptVersion || first.rubricVersion !== second.rubricVersion) {
    throw new JudgeUnavailableError('两轮评审不属于同一冻结作答、模型或规则版本。');
  }
  const dimensions = Object.keys(qualityWeights) as (keyof typeof qualityWeights)[];
  // 任一维在两轮中声明为不可判（score 为 null）时，该维不计入均值和分歧：
  // 把 null 当 0 会伪造均值，并把「未判」误报成「两轮差异过大」。
  const judged = (key: keyof typeof qualityWeights): boolean => first.dimensions[key].score !== null && second.dimensions[key].score !== null;
  const averages = Object.fromEntries(dimensions.map(key => [key, judged(key) ? (first.dimensions[key].score! + second.dimensions[key].score!) / 2 : null])) as Record<keyof typeof qualityWeights, number | null>;
  const differences = Object.fromEntries(dimensions.map(key => [key, judged(key) ? Math.abs(first.dimensions[key].score! - second.dimensions[key].score!) : null])) as Record<keyof typeof qualityWeights, number | null>;
  // 差异只作记录，不再阻断评分；两轮不同即由上面的 averages 取平均作为结论。
  const reasons = dimensions.filter(key => differences[key] !== null && differences[key]! > 0)
    .map(key => key + ' 两轮相差 ' + differences[key] + ' 分，取平均 ' + averages[key] + '。');
  // 两轮都声明「不可判」才是真正的待定：这时没有可平均的东西。
  const unjudged = dimensions.filter(key => !judged(key));
  if (unjudged.length > 0) reasons.push('两轮均未判定这些维度，其分数保持待定：' + unjudged.join('、') + '。');
  // 客观分尚未知时，用其合法取值范围检查两轮是否可能跨越总分门槛。
  // 每维满分来自契约（现为三维 50/3），不是四维时代的固定 12.5——否则门槛判断会差 1.33 倍。
  const reviewContribution = (verdict: ReviewVerdict) => dimensions.reduce((sum, key) => sum + (verdict.dimensions[key].score ?? 0) * (1 - qualityWeights[key]) * qualityPointsPerDimension / 100, 0);
  const low = Math.min(reviewContribution(first), reviewContribution(second));
  const high = Math.max(reviewContribution(first), reviewContribution(second));
  const objectiveMaximum = dimensions.reduce((sum, key) => sum + qualityWeights[key] * qualityPointsPerDimension, 0);
  if (functional !== null && low !== high && functional + low < 70 && functional + high + objectiveMaximum >= 70) {
    reasons.push('两轮评审可能改变总分门槛结论，需要结合客观分复核。');
  }
  return { averages, differences, needsHumanReview: false, reasons, comparabilityWarnings: [] as string[] };
}
