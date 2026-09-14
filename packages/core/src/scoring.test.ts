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

import { scoreExecution } from './index.ts';
import type { ExecutionResult, TaskManifest } from '@fsa/contracts';

function manifestFixture(criticalId = 'public/behavior'): TaskManifest {
  const id = (value: string) => value;
  const check = (value: string, group: 'behavior' | 'boundary' | 'state' | 'regression' | 'resources', critical: boolean) => ({
    id: value, kind: 'public' as const, group, weight: 1, critical, summary: '测试检查 ' + value,
  });
  return {
    schemaVersion: '0.1.0', taskId: 'CACHE-02', taskVersion: '0.1.0', title: '测试题', runtime: 'typescript',
    runtimeRange: 'node >=24.14.1 <25',
    workspace: { entries: [{ from: 'task.md', to: 'TASK.md' }] },
    commands: { public: ['node', 'x'], hidden: ['node', 'y'] },
    grader: { checks: 'graders/CACHE-02/checks', referencePatch: 'graders/CACHE-02/reference.patch', alternative: 'graders/CACHE-02/alternative', defectDetectors: [id('public/behavior')] },
    limits: { timeoutMs: 60000, memoryMb: 512, cpus: 1, network: false },
    checks: [
      check('public/behavior', 'behavior', criticalId === 'public/behavior'),
      check('public/boundary', 'boundary', criticalId === 'public/boundary'),
      check('public/state', 'state', false),
      check('public/regression', 'regression', false),
      check('public/resources', 'resources', false),
    ],
  };
}

function executionFixture(statuses: Record<string, 'passed' | 'failed' | 'not-run'>, classification: ExecutionResult['classification']): ExecutionResult {
  return {
    schemaVersion: '0.1.0', runId: 'run-test', attemptId: 'attempt-test', taskId: 'CACHE-02', taskVersion: '0.1.0',
    candidateTreeHash: 'a'.repeat(64), classification, isolation: 'none',
    startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z', durationMs: 1000,
    environment: { profile: 'local', image: null, imageDigest: null, platform: 'test x64', platformVersion: 'v24', candidateRuntimes: ['node'], containerRuntime: null, cpus: 1, totalMemoryMb: 1024, network: false },
    phases: [{ kind: 'public', declaredCommand: ['node', 'x'], argv: ['node', 'x'], cwd: '/w', timeoutMs: 60000, exitCode: 1, signal: null, timedOut: false, cancelled: false, durationMs: 10, resource: { peakRssBytes: null, userCpuMs: null, systemCpuMs: null, sampler: 'unavailable' }, missing: [], artifacts: [] }],
    checks: manifestFixture().checks.map(check => ({
      id: check.id, kind: check.kind, group: check.group, critical: check.critical,
      status: statuses[check.id] ?? 'not-run', durationMs: 1,
    })),
    artifacts: [], evidenceRefs: ['public.stdout'], notes: [],
  };
}

describe('正式评分桥：执行结果 → 可用验证分', () => {
  it('全部通过时可用验证 50 分，但总分仍待定', () => {
    const score = scoreExecution(executionFixture({
      'public/behavior': 'passed', 'public/boundary': 'passed', 'public/state': 'passed', 'public/regression': 'passed', 'public/resources': 'passed',
    }, 'passed'), manifestFixture());
    expect(score.mode).toBe('formal');
    expect(score.functional).toBe(50);
    expect(score.quality).toBeNull();
    expect(score.total).toBeNull();
    expect(score.readiness).toBe('complete');
    expect(score.thresholdMet).toBeNull();
    expect(score.groups.map(group => group.score)).toEqual([100, 100, 100, 100, 100]);
    expect(score.reasons.join(' ')).toContain('代码质量证据缺失');
  });

  it('分组按权重折算，失败组记 0 而不是重新归一化', () => {
    const score = scoreExecution(executionFixture({
      'public/behavior': 'passed', 'public/boundary': 'failed', 'public/state': 'passed', 'public/regression': 'passed', 'public/resources': 'passed',
    }, 'check-failed'), manifestFixture());
    expect(score.functional).toBe(40);
    expect(score.groups.find(group => group.group === 'boundary')).toMatchObject({ score: 0, weightPassed: 0, weightTotal: 1 });
  });

  it('关键验收项失败时明确不合格', () => {
    const score = scoreExecution(executionFixture({
      'public/behavior': 'failed', 'public/boundary': 'passed', 'public/state': 'passed', 'public/regression': 'passed', 'public/resources': 'passed',
    }, 'check-failed'), manifestFixture());
    expect(score.criticalPassed).toBe(false);
    expect(score.thresholdMet).toBe(false);
    expect(score.reasons.join(' ')).toContain('关键验收项');
  });

  it('超时把未取得的检查项按被测失败记 0', () => {
    const score = scoreExecution(executionFixture({ 'public/behavior': 'passed' }, 'timeout'), manifestFixture());
    expect(score.functional).toBe(20);
    expect(score.readiness).toBe('complete');
    expect(score.reasons.join(' ')).toContain('时间预算');
  });

  it('基础设施故障与取消不给分数', () => {
    for (const classification of ['infrastructure-error', 'cancelled'] as const) {
      const score = scoreExecution(executionFixture({ 'public/behavior': 'passed' }, classification), manifestFixture());
      expect(score.functional).toBeNull();
      expect(score.readiness).toBe(classification === 'infrastructure-error' ? 'infra-error' : 'pending');
    }
  });
});
