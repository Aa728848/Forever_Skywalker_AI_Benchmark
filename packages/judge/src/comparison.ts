import { qualityPointsPerDimension, qualityWeights, type ReviewVerdict } from '@fsa/contracts';
import { JudgeUnavailableError } from './index.ts';

/**
 * 合并一次作答取得的一轮或多轮独立判决。
 *
 * 两条规则（2026-09-27，用户要求「不能出现待定」）：
 *
 * 1. **按维取可用轮次**：某一维只要有一轮给出有效分数，就用这一轮；两轮都给出就取平均。
 *    旧实现要求两轮**同时**给出分数，否则该维待定——实测 MiniMax 的 LSP-02 第 1 轮声明
 *    simplicity 不可判、第 2 轮给出 85，于是整题质量分与总分白白待定。声明不可判是
 *    「这一轮判不了」，不是「这个分数不存在」；丢掉另一轮的真实分数是浪费证据，而非谨慎。
 *    这与「缺证据不得补分」不冲突：这里用的都是裁判真实给出的分数，没有一分是推断的。
 *    所有轮次都判不了时该维仍为 null，总分仍然待定。
 *
 * 2. **单轮也可成立**：只剩一轮有效判决时（另一轮会话失败或未完成），直接采用该轮分数，
 *    并在 reasons 与 comparabilityWarnings 里显式标注「仅 1 轮」，供复核判断置信度。
 *    旧实现要求两轮齐备，一轮失败即整题作废——实测 Google 的 LSP-02 第 1 轮会话 error、
 *    第 2 轮根本没有发起，整题永远待定。
 *
 * 差异仍然逐维记录（differences），供报告与人工复核参考；分歧本身不阻断评分。
 */
export function mergeReviewRounds(
  verdicts: readonly ReviewVerdict[],
  functional: number | null = null,
) {
  if (verdicts.length === 0) throw new JudgeUnavailableError('没有可合并的评审判决。');
  const first = verdicts[0]!;
  for (const other of verdicts.slice(1)) {
    if (other.runId !== first.runId || other.attemptId !== first.attemptId || other.taskId !== first.taskId
      || other.model !== first.model || other.promptVersion !== first.promptVersion || other.rubricVersion !== first.rubricVersion) {
      throw new JudgeUnavailableError('两轮评审不属于同一冻结作答、模型或规则版本。');
    }
  }
  const dimensions = Object.keys(qualityWeights) as (keyof typeof qualityWeights)[];
  /** 该维实际给出分数的轮次数量：0 = 真正待定，1 = 单轮结论，2 及以上 = 取平均。 */
  const roundsJudged = Object.fromEntries(dimensions.map(key => [
    key, verdicts.filter(verdict => verdict.dimensions[key].score !== null).length,
  ])) as Record<keyof typeof qualityWeights, number>;
  const scoresOf = (key: keyof typeof qualityWeights): number[] =>
    verdicts.map(verdict => verdict.dimensions[key].score).filter((score): score is number => score !== null);
  const averages = Object.fromEntries(dimensions.map(key => {
    const scores = scoresOf(key);
    return [key, scores.length === 0 ? null : scores.reduce((sum, value) => sum + value, 0) / scores.length];
  })) as Record<keyof typeof qualityWeights, number | null>;
  // 只有一轮时无从谈「分歧」：单点算不出差异，报 null 而不是伪造一个 0。
  const differences = Object.fromEntries(dimensions.map(key => {
    const scores = scoresOf(key);
    return [key, scores.length > 1 ? Math.max(...scores) - Math.min(...scores) : null];
  })) as Record<keyof typeof qualityWeights, number | null>;
  const reasons: string[] = [];
  const roundLabel = verdicts.length > 1 ? '两轮' : '仅有的 1 轮';
  for (const key of dimensions) {
    const difference = differences[key];
    if (difference !== null && difference > 0) reasons.push(key + ' 两轮相差 ' + difference + ' 分，取平均 ' + averages[key] + '。');
    // 单轮结论必须显式标注：它没有第二轮交叉验证，置信度低于两轮平均。
    if (verdicts.length > 1 && roundsJudged[key] === 1) {
      reasons.push(key + ' 仅 1 轮给出有效判决（另一轮未判定该维），直接采用该轮分数 ' + averages[key] + '。');
    }
  }
  // 所有轮次都没给出分数的维度才是真正的待定：这时没有任何可平均、可采用的分数。
  const unjudged = dimensions.filter(key => roundsJudged[key] === 0);
  if (unjudged.length > 0) reasons.push(roundLabel + '均未判定这些维度，其分数保持待定：' + unjudged.join('、') + '。');
  const comparabilityWarnings: string[] = [];
  if (verdicts.length === 1) comparabilityWarnings.push('该题只有 1 轮有效判决（另一轮未取得有效结论），质量分按单轮给出，未经第二轮交叉验证。');
  // 客观分尚未知时，用其合法取值范围检查各轮是否可能跨越总分门槛。
  // 每维满分来自契约（现为三维 50/3），不是四维时代的固定 12.5——否则门槛判断会差 1.33 倍。
  const objectiveMaximum = dimensions.reduce((sum, key) => sum + qualityWeights[key] * qualityPointsPerDimension, 0);
  const contribution = (verdict: ReviewVerdict) => dimensions.reduce((sum, key) => sum + (verdict.dimensions[key].score ?? 0) * (1 - qualityWeights[key]) * qualityPointsPerDimension / 100, 0);
  const contributions = verdicts.map(contribution);
  const low = Math.min(...contributions);
  const high = Math.max(...contributions);
  if (functional !== null && low !== high && functional + low < 70 && functional + high + objectiveMaximum >= 70) {
    reasons.push('各轮评审可能改变总分门槛结论，需要结合客观分复核。');
  }
  return { averages, differences, roundsJudged, needsHumanReview: false, reasons, comparabilityWarnings };
}

/**
 * 两轮比较的兼容入口：语义等同 mergeReviewRounds([first, second], functional)。
 * 保留它是因为「两轮独立判决」仍是默认形态，调用方按两轮写出更清楚。
 */
export function compareReviews(first: ReviewVerdict, second: ReviewVerdict, functional: number | null = null) {
  return mergeReviewRounds([first, second], functional);
}