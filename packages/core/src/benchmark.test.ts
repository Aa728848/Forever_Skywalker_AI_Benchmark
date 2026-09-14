import { describe, expect, it } from 'vitest';
import { scoreBenchmark, type BenchmarkPolicy, type BenchmarkSamples } from './benchmark.ts';

const policy: BenchmarkPolicy = { version: 'test-1', environmentHash: 'a'.repeat(64), calibrated: false,
  warmupRounds: 2, minimumPairs: 7, metrics: [{ id: 'durationMs', direction: 'lower', good: 1, bad: 3, weight: 1 }] };
const samples: BenchmarkSamples = { evidenceId: 'benchmark-report', environmentHash: policy.environmentHash,
  correctnessPassed: true, warmupRounds: 2, pairs: [2, 2, 2, 2, 2, 2, 100].map((ratio, index) => ({
    round: index + 1, candidate: { durationMs: ratio * 10 }, reference: { durationMs: 10 },
  })) };

describe('同机成对性能证据评分', () => {
  it('按中位比值评分且保留异常轮和离散度，不挑最好结果', () => {
    const report = scoreBenchmark(samples, policy);
    expect(report).toMatchObject({ score: 50, calibrated: false });
    expect(report.metrics[0]).toMatchObject({ ratio: 2, candidateMedian: 20, referenceMedian: 10, medianAbsoluteDeviation: 0 });
    expect(report.samples.pairs.at(-1)?.candidate.durationMs).toBe(1000);
  });

  it('支持吞吐越高越好与公开指标权重', () => {
    expect(scoreBenchmark(samples, { ...policy, metrics: [{ id: 'durationMs', direction: 'higher', good: 3, bad: 1, weight: 1 }] }).score).toBe(50);
  });

  it.each([
    { ...samples, correctnessPassed: false },
    { ...samples, environmentHash: 'b'.repeat(64) },
    { ...samples, pairs: samples.pairs.slice(1) },
    { ...samples, warmupRounds: 0 },
    { ...samples, pairs: samples.pairs.map(pair => ({ ...pair, round: 1 })) },
    { ...samples, pairs: samples.pairs.map(pair => ({ ...pair, candidate: { durationMs: NaN } })) },
  ])('拒绝语义错误、环境不一致和缺失/挑选过的样本', invalid => {
    expect(() => scoreBenchmark(invalid, policy)).toThrow();
  });
});
