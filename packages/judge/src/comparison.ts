import { qualityWeights, type ReviewVerdict } from '@fsa/contracts';
import { JudgeUnavailableError } from './index.ts';

/** 保留原始两轮判决；均值仅供复核，发生大分歧时调用方不得直接终结评分。 */
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
  const reasons = dimensions.filter(key => differences[key] !== null && differences[key]! > 20).map(key => key + ' 两轮差异超过 20 分。');
  const unjudged = dimensions.filter(key => !judged(key));
  if (unjudged.length > 0) reasons.push('两轮均未判定这些维度，其分数保持待定：' + unjudged.join('、') + '。');
  // 客观分尚未知时，用其合法取值范围检查两轮是否可能跨越总分门槛。
  const reviewContribution = (verdict: ReviewVerdict) => dimensions.reduce((sum, key) => sum + (verdict.dimensions[key].score ?? 0) * (1 - qualityWeights[key]) * 0.125, 0);
  const low = Math.min(reviewContribution(first), reviewContribution(second));
  const high = Math.max(reviewContribution(first), reviewContribution(second));
  const objectiveMaximum = dimensions.reduce((sum, key) => sum + qualityWeights[key] * 12.5, 0);
  if (functional !== null && low !== high && functional + low < 70 && functional + high + objectiveMaximum >= 70) {
    reasons.push('两轮评审可能改变总分门槛结论，需要结合客观分复核。');
  }
  return { averages, differences, needsHumanReview: reasons.length > 0, reasons };
}
