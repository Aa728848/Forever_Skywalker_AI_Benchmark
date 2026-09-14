export interface BenchmarkPolicy {
  readonly version: string;
  readonly environmentHash: string;
  readonly calibrated: boolean;
  readonly warmupRounds: number;
  readonly minimumPairs: number;
  /** good/bad 是同轮候选值与参考值之比；策略及权重必须在作答前冻结。 */
  readonly metrics: readonly { readonly id: string; readonly direction: 'lower' | 'higher'; readonly good: number; readonly bad: number; readonly weight: number }[];
}

export interface BenchmarkSamples {
  readonly evidenceId: string;
  readonly environmentHash: string;
  readonly correctnessPassed: boolean;
  readonly warmupRounds: number;
  readonly pairs: readonly { readonly round: number; readonly candidate: Readonly<Record<string, number>>; readonly reference: Readonly<Record<string, number>> }[];
}

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
};

/** 纯函数：只换算受信原始测量，拒绝缺样本、错误语义或不同环境的结果，不发起任何执行。 */
export function scoreBenchmark(samples: BenchmarkSamples, policy: BenchmarkPolicy) {
  if (!samples.correctnessPassed) throw new Error('正确性尚未全部通过，不计算性能分。');
  if (!/^[a-f0-9]{64}$/.test(policy.environmentHash) || samples.environmentHash !== policy.environmentHash) throw new Error('性能样本与冻结策略的环境哈希不一致。');
  if (policy.version.trim() === '' || samples.evidenceId.trim() === '') throw new Error('性能规则版本与证据 ID 不能为空。');
  if (!Number.isSafeInteger(policy.warmupRounds) || policy.warmupRounds < 2 || samples.warmupRounds !== policy.warmupRounds
    || !Number.isSafeInteger(policy.minimumPairs) || policy.minimumPairs < 7 || samples.pairs.length < policy.minimumPairs) {
    throw new Error('性能测量必须满足冻结预热次数（至少 2 轮）及成对重复次数（至少 7 轮）。');
  }
  if (samples.pairs.some((pair, index) => pair.round !== index + 1)) throw new Error('性能样本轮次必须连续，不得遗漏或重复选取样本。');
  if (policy.metrics.length === 0 || new Set(policy.metrics.map(metric => metric.id)).size !== policy.metrics.length) throw new Error('性能指标不能为空或重复。');
  const metrics = policy.metrics.map(metric => {
    if (![metric.good, metric.bad, metric.weight].every(value => Number.isFinite(value) && value > 0)
      || (metric.direction === 'lower' ? metric.good >= metric.bad : metric.direction === 'higher' ? metric.good <= metric.bad : true)) {
      throw new Error('性能指标阈值或权重不合法：' + metric.id);
    }
    const candidate = samples.pairs.map(pair => pair.candidate[metric.id]);
    const reference = samples.pairs.map(pair => pair.reference[metric.id]);
    if ([...candidate, ...reference].some(value => value === undefined || !Number.isFinite(value) || value <= 0)) throw new Error('性能原始样本缺失或无效：' + metric.id);
    const ratios = candidate.map((value, index) => value! / reference[index]!);
    const ratio = median(ratios);
    const score = 100 * Math.max(0, Math.min(1, metric.direction === 'lower'
      ? (metric.bad - ratio) / (metric.bad - metric.good) : (ratio - metric.bad) / (metric.good - metric.bad)));
    return { id: metric.id, score, ratio, candidateMedian: median(candidate as number[]), referenceMedian: median(reference as number[]),
      medianAbsoluteDeviation: median(ratios.map(value => Math.abs(value - ratio))), ratios, weight: metric.weight };
  });
  return { ruleVersion: policy.version, evidenceId: samples.evidenceId, environmentHash: policy.environmentHash, calibrated: policy.calibrated,
    score: metrics.reduce((sum, metric) => sum + metric.score * metric.weight, 0) / metrics.reduce((sum, metric) => sum + metric.weight, 0),
    metrics, samples };
}
