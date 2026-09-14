import { describe, expect, it } from 'vitest';
import sample from '../../../examples/assessment.json';
import { parseAssessment, scoreAssessment, summarizeLevels } from './index.ts';
import type { Assessment } from '@fsa/contracts';

function input(functional = 100, objective = 100, review = objective): Assessment {
  const value = parseAssessment(structuredClone(sample));
  for (const item of Object.values(value.functional)) item.score = functional;
  for (const item of Object.values(value.quality)) {
    item.objective.score = objective;
    item.review.score = review;
  }
  return value;
}

describe('50/50 评分与门槛', () => {
  it('保持四维比例及各自的客观/评审比例', () => {
    const result = scoreAssessment(input(100, 100, 0));
    expect(result).toMatchObject({ functional: 50, quality: 25, total: 75, thresholdMet: true, mode: 'preview' });
    expect(result.dimensions).toEqual({ simplicity: 40, maintainability: 30, decoupling: 50, performance: 80 });
  });
  it('不以代码高分补偿可用验证门槛', () => {
    expect(scoreAssessment(input(70))).toMatchObject({ total: 85, functional: 35, thresholdMet: false });
  });
  it('保留高原始分，但关键验收失败仍不合格', () => {
    const value = input();
    value.criticalChecks[0]!.passed = false;
    expect(scoreAssessment(value)).toMatchObject({ total: 100, thresholdMet: false, readiness: 'complete' });
  });
  it('不让两位小数展示跨越真实门槛', () => {
    expect(scoreAssessment(input(80, 59.998))).toMatchObject({ total: 70, thresholdMet: false });
  });
  it('缺失评审分时不重新分配权重', () => {
    const value = input();
    value.quality.maintainability.review = { score: null, evidence: [] };
    expect(scoreAssessment(value)).toMatchObject({ functional: 50, quality: null, total: null, readiness: 'pending', thresholdMet: null });
  });
  it.each(['infra-error', 'incomplete'] as const)('%s 不产生总分', execution => {
    expect(scoreAssessment({ ...input(), execution })).toMatchObject({ total: null, thresholdMet: null });
  });
  it('关键项待定不变成失败或通过', () => {
    const value = input();
    value.criticalChecks[0]!.passed = null;
    expect(scoreAssessment(value)).toMatchObject({ total: null, readiness: 'pending' });
  });
});

describe('不可信输入边界', () => {
  it.each([NaN, Infinity, -1, 101, '100'])('拒绝非法分数 %s', score => {
    const value = input();
    expect(() => scoreAssessment({ ...value, functional: { ...value.functional, behavior: { score, evidence: ['demo-test'] } } })).toThrow();
  });
  it('拒绝空证据、未知引用和证据类型混用', () => {
    const value = input();
    for (const refs of [[], ['missing'], ['demo-review']]) {
      value.functional.behavior.evidence = refs;
      expect(() => scoreAssessment(value)).toThrow(/证据/);
    }
  });
  it('拒绝重复证据和未知字段', () => {
    const value = input();
    value.evidence.push(value.evidence[0]!);
    expect(() => scoreAssessment(value)).toThrow(/重复/);
    expect(() => scoreAssessment({ ...input(), official: true })).toThrow(/协议/);
  });
});

describe('四级汇总', () => {
  const tasks = [
    { id: 'a', difficulty: 'easy', track: 'core' }, { id: 'b', difficulty: 'medium', track: 'core' },
    { id: 'c', difficulty: 'hard', track: 'core' }, { id: 'd', difficulty: 'extreme', track: 'core' },
    { id: 'integration', difficulty: 'extreme', track: 'integration' },
  ] as const;
  it('按 10/20/30/40 汇总且不混入集成题', () => {
    const reports = [80, 85, 90, 100].map((score, index) => ({ taskId: tasks[index]!.id, result: scoreAssessment(input(score, score)) }));
    reports.push({ taskId: 'integration', result: scoreAssessment(input(0, 0)) });
    expect(summarizeLevels(tasks, reports)).toMatchObject({ weightedTotal: 92, highestConsecutiveLevel: 'extreme' });
  });
  it('缺级不重分配权重，低等级未通过不能认证更高级', () => {
    const reports = tasks.slice(0, 4).map(task => ({ taskId: task.id, result: scoreAssessment(input(task.id === 'a' ? 50 : 100)) }));
    expect(summarizeLevels(tasks, reports).highestConsecutiveLevel).toBeNull();
    expect(summarizeLevels(tasks, reports.slice(0, 3)).weightedTotal).toBeNull();
  });
  it('不隐式挑选重复作答或接受题库外结果', () => {
    const report = { taskId: 'a', result: scoreAssessment(input()) };
    expect(() => summarizeLevels(tasks, [report, report])).toThrow(/一次作答/);
    expect(() => summarizeLevels(tasks, [{ ...report, taskId: 'unknown' }])).toThrow(/题库以外/);
  });
});
