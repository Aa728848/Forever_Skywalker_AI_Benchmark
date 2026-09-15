import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createEnvelope, createRunStore } from '@fsa/runs';
import { readExecutionResult, readExecutionScore, readRunStatus, reviewCompletedAttempt, verifySubmission } from '@fsa/executor';
import { sampleVerdict, type JudgeAdapter, type ReviewRequest } from '@fsa/judge';
import { applyReferencePatch, exportWorkspace, readManifest } from '@fsa/tasks';
import { createQualityProvider, summarizeRuns } from './index.ts';
import { inspectRunSelection } from './suite.ts';

it('裁判长堆栈不破坏已完成的执行记录，首次评分和补评都保留原始错误', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'fsa-evaluation-'));
  try {
    const candidate = join(scratch, 'candidate');
    exportWorkspace('CACHE-02', candidate);
    expect(applyReferencePatch(readManifest('CACHE-02'), candidate, join(scratch, 'patch')).exitCode).toBe(0);
    const store = createRunStore(join(scratch, 'runs'));
    const message = 'cannot get property "tools" without inject\n' + 'DSH startup stack\n'.repeat(220);
    const judge: JudgeAdapter = { model: 'test', promptVersion: 'review-v1', async review() { throw new Error(message); } };
    const qualityProvider = createQualityProvider({ judge, env: {}, measurePerformance: false });
    const envelope = createEnvelope('CACHE-02', candidate);
    const outcome = await verifySubmission({ store, taskId: 'CACHE-02', envelope, candidateDirectory: candidate, submittedBy: 'test', qualityProvider });
    const selection = { runId: envelope.runId, attemptId: envelope.attemptId };
    expect(readRunStatus(store, selection.runId, selection.attemptId)).toMatchObject({ classification: 'passed', scoring: { functional: 50, quality: null } });
    await reviewCompletedAttempt({ store, ...selection, qualityProvider });
    for (const revision of ['execution', 'execution-2']) {
      const directory = join(outcome.submission.directory, revision);
      expect(JSON.parse(readFileSync(join(directory, 'review-error.json'), 'utf8')).message).toBe(message);
      expect(JSON.parse(readFileSync(join(directory, 'execution-notes.json'), 'utf8')).some((note: string) => note.includes(message))).toBe(true);
    }
    const recorded = readExecutionResult(outcome.submission.directory)!;
    expect(recorded.notes.every(note => note.length <= 2000)).toBe(true);
    expect(recorded.notes.join(' ')).toContain('without inject');
    expect(readExecutionScore(outcome.submission.directory)).toMatchObject({ functional: 50, total: null });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

it('真实执行后使用冻结材料评审，缺性能证据不补分，显式重评保留历史', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'fsa-evaluation-'));
  try {
    const candidate = join(scratch, 'candidate');
    exportWorkspace('CACHE-02', candidate);
    expect(applyReferencePatch(readManifest('CACHE-02'), candidate, join(scratch, 'patch')).exitCode).toBe(0);
    const store = createRunStore(join(scratch, 'runs'));
    const calls: ReviewRequest[] = [];
    const configuration = { provider: 'test', api: 'chat-completions' as const, model: 'scripted-test', promptVersion: 'review-v1',
      parameters: { reasoning_effort: 'high' }, parametersFingerprint: 'a'.repeat(64) };
    const judge: JudgeAdapter = {
      model: 'scripted-test', promptVersion: 'review-v1', configuration,
      async review(request) {
        calls.push(structuredClone(request));
        return { source: 'scripted', calls: calls.length, inputTokens: 20, outputTokens: 10,
          configuration: calls.length === 4 ? { ...configuration, parametersFingerprint: 'b'.repeat(64) } : configuration,
          verdict: sampleVerdict(request, { simplicity: 80, maintainability: 80, decoupling: 80, performance: 80 },
            ['task-contract', 'execution-evidence', 'source-0'], 'scripted-test') };
      },
    };
    const provider = createQualityProvider({ judge, measurePerformance: false, env: { BENCH_JUDGE_TOKEN: 'must-never-be-written' } });
    const envelope = createEnvelope('CACHE-02', candidate, { idempotencyKey: 'evaluation-test' });
    const request = { store, taskId: 'CACHE-02', envelope, candidateDirectory: candidate, submittedBy: 'evaluation-test', qualityProvider: provider };
    const first = await verifySubmission(request);
    expect(first.execution.classification).toBe('passed');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.materials).toEqual(calls[1]!.materials);
    expect(calls[0]!.roundId).toBe('1');
    expect(calls[1]!.roundId).toBe('2');
    expect(readExecutionScore(first.submission.directory)).toMatchObject({ mode: 'rehearsal', functional: 50, quality: null, total: null });
    const originalScorePath = join(first.submission.directory, 'execution', 'score.json');
    const originalScore = readFileSync(originalScorePath, 'utf8');
    const materialText = readFileSync(join(first.submission.directory, 'execution', 'review-materials.json'), 'utf8');
    expect(JSON.parse(materialText).configuration).toEqual(configuration);
    expect(materialText).not.toContain('must-never-be-written');
    await verifySubmission(request);
    expect(calls).toHaveLength(2);
    writeFileSync(join(candidate, 'starter', 'src', 'keyed-loader.ts'), 'throw new Error("mutable-copy-only");');
    const revised = await reviewCompletedAttempt({ store, runId: first.submission.attempt.runId,
      attemptId: first.submission.attempt.attemptId, qualityProvider: provider });
    expect(revised.functional).toBe(50);
    expect(revised.dimensions.simplicity).toBeNull();
    const comparison = JSON.parse(readFileSync(join(first.submission.directory, 'execution-2', 'review-comparison.json'), 'utf8'));
    expect(comparison.needsHumanReview).toBe(true);
    expect(comparison.reasons.join(' ')).toContain('冻结配置');
    expect(calls).toHaveLength(4);
    expect(JSON.stringify(calls.at(-1)!.materials)).not.toContain('mutable-copy-only');
    expect(readFileSync(originalScorePath, 'utf8')).toBe(originalScore);
    const selected = { runId: first.submission.attempt.runId, attemptId: first.submission.attempt.attemptId };
    expect(summarizeRuns(store, [selected])).toMatchObject({ mode: 'local', weightedTotal: null, highestConsecutiveLevel: null });
    const inspection = inspectRunSelection(store, [selected, selected]);
    expect(inspection.selected).toHaveLength(2);
    expect(inspection.selected[0]).toMatchObject({ ...selected, scoreRevision: 'execution-2', total: null });
    expect(inspection.environmentKey).toMatch(/^[a-f0-9]{64}$/);
    expect(inspection.judgeKey).toBe(JSON.stringify(['a'.repeat(64), 'unreported']));
    expect(() => summarizeRuns(store, [selected, selected])).toThrow('同一题只能选择一次');
    await reviewCompletedAttempt({ store, ...selected, qualityProvider: createQualityProvider({ measurePerformance: true, env: {} }) });
    const latest = JSON.parse(readFileSync(join(first.submission.directory, 'execution-3', 'benchmark-samples.json'), 'utf8'));
    expect(latest).toMatchObject({ workload: 'full-verification-cost', result: { calibrated: false } });
    expect(latest.rawRuns).toHaveLength(18);
  } finally {
    const target = resolve(scratch);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('fsa-evaluation-')) throw new Error('测试临时目录越界。');
    rmSync(target, { recursive: true, force: true });
  }
}, 30000);

it('专用性能负载使用冻结快照和外部计时，保存全部配对而不冒充已校准', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'fsa-evaluation-'));
  try {
    const candidate = join(scratch, 'candidate');
    exportWorkspace('PERF-04', candidate);
    expect(applyReferencePatch(readManifest('PERF-04'), candidate, join(scratch, 'patch')).exitCode).toBe(0);
    const store = createRunStore(join(scratch, 'runs'));
    const envelope = createEnvelope('PERF-04', candidate, { idempotencyKey: 'dedicated-perf' });
    const outcome = await verifySubmission({ store, taskId: 'PERF-04', envelope, candidateDirectory: candidate, submittedBy: 'test',
      qualityProvider: createQualityProvider({ measurePerformance: true, env: {} }) });
    const evidencePath = join(outcome.submission.directory, 'execution', 'benchmark-samples.json');
    expect(existsSync(evidencePath), outcome.execution.notes.join('\n')).toBe(true);
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    expect(evidence).toMatchObject({ workload: 'task-dedicated-workload', includesStartupAndAssertions: true, result: { calibrated: false } });
    expect(evidence.rawRuns).toHaveLength(18);
    expect(evidence.result.samples.pairs).toHaveLength(7);
    expect(evidence.rawRuns.every((run: { durationMs: number; diagnostic: { trust: string } }) => run.durationMs > 0 && run.diagnostic.trust === 'in-process-diagnostic')).toBe(true);
    expect(readExecutionScore(outcome.submission.directory)).toMatchObject({ mode: 'local', functional: 50, total: null });
  } finally {
    const target = resolve(scratch);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('fsa-evaluation-')) throw new Error('测试临时目录越界。');
    rmSync(target, { recursive: true, force: true });
  }
}, 60000);

it('不同题目的裁判参数不混入同一汇总，统一配置的补评修订可重新汇总', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'fsa-evaluation-'));
  const store = createRunStore(join(scratch, 'runs'));
  const provider = (fingerprint: string) => {
    const configuration = { provider: 'test', api: 'chat-completions' as const, model: 'test-judge', promptVersion: 'review-v1',
      parameters: { reasoning_effort: fingerprint === 'a' ? 'high' : 'low' }, parametersFingerprint: fingerprint.repeat(64) };
    return createQualityProvider({ measurePerformance: false, env: {}, judge: {
      model: 'test-judge', promptVersion: 'review-v1', configuration,
      async review(request) { return { source: 'scripted', configuration, calls: 1, inputTokens: 10, outputTokens: 10,
        verdict: sampleVerdict(request, { simplicity: 80, maintainability: 80, decoupling: 80, performance: 80 }, ['task-contract', 'execution-evidence'], 'test-judge') }; },
    } });
  };
  try {
    const selection: Array<{ runId: string; attemptId: string }> = [];
    for (const [index, taskId] of ['CACHE-01', 'CACHE-02'].entries()) {
      const candidate = join(scratch, taskId);
      exportWorkspace(taskId, candidate);
      expect(applyReferencePatch(readManifest(taskId), candidate, join(scratch, 'patch-' + taskId)).exitCode).toBe(0);
      const envelope = createEnvelope(taskId, candidate, { idempotencyKey: 'profiles-' + taskId });
      const result = await verifySubmission({ store, taskId, envelope, candidateDirectory: candidate, submittedBy: 'test', qualityProvider: provider(index === 0 ? 'a' : 'b') });
      selection.push({ runId: result.execution.runId, attemptId: result.execution.attemptId });
    }
    expect(() => summarizeRuns(store, selection)).toThrow('裁判参数');
    expect(() => inspectRunSelection(store, selection)).toThrow('裁判参数');
    expect(inspectRunSelection(store, [selection[0]!]).judgeKey).not.toBe(inspectRunSelection(store, [selection[1]!]).judgeKey);
    await reviewCompletedAttempt({ store, ...selection[1]!, qualityProvider: provider('a') });
    expect(inspectRunSelection(store, selection).judgeKey).toBe(JSON.stringify(['a'.repeat(64), 'unreported']));
    expect(summarizeRuns(store, selection)).toMatchObject({ mode: 'local', weightedTotal: null });
  } finally {
    const target = resolve(scratch);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('fsa-evaluation-')) throw new Error('测试临时目录越界。');
    rmSync(target, { recursive: true, force: true });
  }
}, 30000);
