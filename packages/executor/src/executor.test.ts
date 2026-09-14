import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyReferencePatch, exportWorkspace, readManifest } from '@fsa/tasks';
import { createEnvelope, createRunStore, digestTree, readRunEvents, submissionBaseline } from '@fsa/runs';
import type { SubmissionEnvelope } from '@fsa/contracts';
import { classifyExecution, executeAttempt, listRunStatuses, readExecutionScore, readRunStatus, runPhase, staticObjectiveFor, verifySubmission } from './index.ts';

const taskId = 'CACHE-02';

function tempDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function tapCommand(file: string): string[] {
  return ['node', '--test', '--test-isolation=none', '--test-reporter=tap', file];
}

describe('检查阶段执行', () => {
  it('解析 TAP 结果并采集原始资源数据', async () => {
    const workspace = tempDirectory('fsa-phase-');
    try {
      writeFileSync(join(workspace, 'probe.test.ts'), [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "test('probe/ok', () => { assert.equal(1 + 1, 2); });",
        "test('probe/fail', () => { assert.equal(1 + 1, 3); });",
      ].join('\n'));
      const phase = await runPhase({
        kind: 'public', declaredCommand: tapCommand('probe.test.ts'), workspace,
        artifactDir: join(workspace, 'art'), timeoutMs: 30_000, memoryMb: 256,
      });
      expect(phase.outcomes.map(item => [item.id, item.ok])).toEqual([['probe/ok', true], ['probe/fail', false]]);
      expect(phase.outcomes.every(item => typeof item.durationMs === 'number')).toBe(true);
      expect(phase.exitCode).toBe(1);
      expect(phase.timedOut).toBe(false);
      expect(phase.resource.sampler).toBe('node-resource-usage');
      expect(phase.resource.peakRssBytes ?? 0).toBeGreaterThan(0);
      expect(phase.argv).toContain('--max-old-space-size=256');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('超时终止进程并单独归类', async () => {
    const workspace = tempDirectory('fsa-phase-');
    try {
      const phase = await runPhase({
        kind: 'public', declaredCommand: ['node', '-e', 'setTimeout(() => {}, 60000)'], workspace,
        artifactDir: join(workspace, 'art'), timeoutMs: 1500, memoryMb: 256,
      });
      expect(phase.timedOut).toBe(true);
      expect(phase.cancelled).toBe(false);
      expect(classifyExecution([phase], [])).toBe('timeout');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('内存耗尽与普通失败区分', async () => {
    const workspace = tempDirectory('fsa-phase-');
    try {
      const phase = await runPhase({
        kind: 'public',
        declaredCommand: ['node', '-e', "const held = []; for (;;) { held.push('x'.repeat(1 << 20)); }"],
        workspace, artifactDir: join(workspace, 'art'), timeoutMs: 120_000, memoryMb: 64,
      });
      expect(phase.timedOut).toBe(false);
      expect(phase.stderr).toMatch(/heap out of memory|Allocation failed|heap limit/i);
      expect(classifyExecution([phase], [])).toBe('memory-exceeded');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 180_000);

  it('取消与超时互不混淆', async () => {
    const workspace = tempDirectory('fsa-phase-');
    try {
      const controller = new AbortController();
      const running = runPhase({
        kind: 'public', declaredCommand: ['node', '-e', 'setTimeout(() => {}, 60000)'], workspace,
        artifactDir: join(workspace, 'art'), timeoutMs: 60_000, memoryMb: 256, signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 300);
      const phase = await running;
      expect(phase.cancelled).toBe(true);
      expect(phase.timedOut).toBe(false);
      expect(classifyExecution([phase], [])).toBe('cancelled');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('命令无法启动算基础设施故障，不算被测失败', async () => {
    const workspace = tempDirectory('fsa-phase-');
    try {
      const phase = await runPhase({
        kind: 'public', declaredCommand: ['fsa-missing-executable-xyz'], workspace,
        artifactDir: join(workspace, 'art'), timeoutMs: 10_000, memoryMb: 256,
      });
      expect(phase.spawnError).not.toBeNull();
      expect(classifyExecution([phase], [])).toBe('infrastructure-error');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('冻结快照执行', () => {
  it('缺陷候选判 check-failed，参考补丁候选判 passed', async () => {
    const storeRoot = tempDirectory('fsa-exec-store-');
    const candidate = tempDirectory('fsa-exec-candidate-');
    const patched = tempDirectory('fsa-exec-patched-');
    const manifest = readManifest(taskId);
    try {
      exportWorkspace(taskId, candidate);
      exportWorkspace(taskId, patched);
      const applied = applyReferencePatch(manifest, patched, join(storeRoot, 'raw'));
      if (applied.exitCode !== 0) throw new Error(`参考补丁应用失败：${applied.stderr}`);

      const store = createRunStore(storeRoot);
      const envelope = (directory: string): SubmissionEnvelope => ({
        schemaVersion: '0.1.0',
        runId: `run-${randomUUID()}`,
        attemptId: `attempt-${randomUUID()}`,
        taskId,
        taskVersion: manifest.taskVersion,
        baseCommit: submissionBaseline(taskId),
        candidateTreeHash: digestTree(directory).treeHash,
        idempotencyKey: `test-${randomUUID()}`,
        reason: 'operator-submit',
      });

      const defectEnvelope = envelope(candidate);
      store.submit({ taskId, envelope: defectEnvelope, candidateDirectory: candidate, submittedBy: 'test' });
      const defect = await executeAttempt({ store, runId: defectEnvelope.runId, attemptId: defectEnvelope.attemptId });
      expect(defect.classification).toBe('check-failed');
      expect(defect.isolation).toBe('none');
      expect(defect.candidateTreeHash).toBe(defectEnvelope.candidateTreeHash);
      expect(defect.checks.filter(check => check.status === 'failed').map(check => check.id).sort())
        .toEqual([...manifest.grader.defectDetectors].sort());
      expect(defect.checks.every(check => check.status !== 'not-run')).toBe(true);
      expect(defect.artifacts.map(item => item.id)).toContain('public.stdout');
      expect(defect.evidenceRefs.length).toBe(defect.artifacts.length);

      const patchedEnvelope = envelope(patched);
      store.submit({ taskId, envelope: patchedEnvelope, candidateDirectory: patched, submittedBy: 'test' });
      const reference = await executeAttempt({ store, runId: patchedEnvelope.runId, attemptId: patchedEnvelope.attemptId });
      expect(reference.classification).toBe('passed');
      expect(reference.checks.every(check => check.status === 'passed')).toBe(true);
      const referenceScore = readExecutionScore(join(storeRoot, taskId, patchedEnvelope.runId, patchedEnvelope.attemptId));
      expect(referenceScore).toMatchObject({ mode: 'formal', functional: 50, quality: null, total: null, criticalPassed: true, thresholdMet: null });
      expect(referenceScore?.groups.map(group => group.score)).toEqual([100, 100, 100, 100, 100]);
    } finally {
      for (const directory of [storeRoot, candidate, patched]) rmSync(directory, { recursive: true, force: true });
    }
  }, 180_000);

  it('容器档案要求固定镜像，运行时缺失时拒绝执行', async () => {
    const storeRoot = tempDirectory('fsa-exec-store-');
    const candidate = tempDirectory('fsa-exec-candidate-');
    try {
      exportWorkspace(taskId, candidate);
      const store = createRunStore(storeRoot);
      const manifest = readManifest(taskId);
      const envelope: SubmissionEnvelope = {
        schemaVersion: '0.1.0',
        runId: `run-${randomUUID()}`,
        attemptId: `attempt-${randomUUID()}`,
        taskId,
        taskVersion: manifest.taskVersion,
        baseCommit: submissionBaseline(taskId),
        candidateTreeHash: digestTree(candidate).treeHash,
        idempotencyKey: `test-${randomUUID()}`,
        reason: 'operator-submit',
      };
      store.submit({
        taskId, envelope, candidateDirectory: candidate, submittedBy: 'test',
        profile: 'linux-container', image: 'fsa-bench-node24', imageDigest: `sha256:${'a'.repeat(64)}`,
      });
      // 本机没有容器运行时：执行必须拒绝，而不是退回宿主执行。
      await expect(executeAttempt({ store, runId: envelope.runId, attemptId: envelope.attemptId }))
        .rejects.toThrow(/容器运行时不可用|不会在运行期拉取镜像/);
      expect(() => store.submit({
        taskId, envelope, candidateDirectory: candidate, submittedBy: 'test', profile: 'linux-container',
      })).toThrow(/镜像引用与镜像 digest/);
      mkdirSync(join(storeRoot, 'unused'), { recursive: true });
    } finally {
      for (const directory of [storeRoot, candidate]) rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('提交入口自动触发验证', () => {
  it('一次提交完成验证，重复完成事件与进程重启都复用已确认的执行结果', async () => {
    const storeRoot = tempDirectory('fsa-verify-store-');
    const candidate = tempDirectory('fsa-verify-candidate-');
    try {
      exportWorkspace(taskId, candidate);
      const manifest = readManifest(taskId);
      const envelope = createEnvelope(taskId, candidate, { idempotencyKey: `verify-${randomUUID()}` });
      const store = createRunStore(storeRoot);

      const first = await verifySubmission({ store, taskId, envelope, candidateDirectory: candidate, submittedBy: 'test' });
      expect(first.reusedExecution).toBe(false);
      expect(first.submission.outcome).toBe('created');
      expect(first.execution.classification).toBe('check-failed');

      const status = readRunStatus(store, first.submission.attempt.runId, first.submission.attempt.attemptId);
      expect(status.phase).toBe('verified');
      expect(status.classification).toBe('check-failed');
      expect(status.knownFailures.map(item => item.id).sort()).toEqual([...manifest.grader.defectDetectors].sort());
      expect(status.missingChecks).toEqual([]);

      expect(status.retryable.allowed).toBe(false);
      expect(status.evidenceRefs.length).toBeGreaterThan(0);
      expect(status.candidateTreeHash).toBe(envelope.candidateTreeHash);

      // 事件流：冻结两条 + 执行四条，seq 单调递增且同 ID 不重复
      const events = readRunEvents(first.submission.directory);
      expect(events.map(event => event.type)).toEqual([
        'run.created', 'submission.frozen', 'execution.started', 'check.finished', 'check.finished',
        'score.finalized', 'execution.finished',
      ]);
      expect(events.map(event => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(events[2]?.payload).toMatchObject({ isolation: 'none' });
      expect(events[3]?.payload).toMatchObject({ phase: 'public' });

      // 正式评分：可用验证分项由执行结果算出，质量缺失时总分待定
      const score = readExecutionScore(first.submission.directory);
      expect(score).toMatchObject({ mode: 'formal', quality: null, total: null, criticalPassed: false, thresholdMet: false });
      expect(score?.groups.find(group => group.group === 'boundary')).toMatchObject({ weightPassed: 2, weightTotal: 5 });
      expect(score?.functional).toBeGreaterThan(0);
      expect(score?.functional).toBeLessThan(50);
      expect(status.scoring).toMatchObject({ mode: 'formal', total: null, quality: null });
      expect(status.scoring.functional).toBe(score?.functional);

      // 重复完成事件：不得重跑检查
      const again = await verifySubmission({ store, taskId, envelope, candidateDirectory: candidate, submittedBy: 'test' });
      expect(again.submission.outcome).toBe('reused');
      expect(again.reusedExecution).toBe(true);
      expect(again.execution.finishedAt).toBe(first.execution.finishedAt);
      const reusedEvents = readRunEvents(again.submission.directory);
      expect(reusedEvents.map(event => event.type).at(-1)).toBe('execution.reused');
      expect(reusedEvents.filter(event => event.type === 'execution.reused')).toHaveLength(1);

      // 进程重启：同一存储目录、新的 store 实例，仍不得重跑
      const restarted = createRunStore(storeRoot);
      const afterRestart = await verifySubmission({ store: restarted, taskId, envelope, candidateDirectory: candidate, submittedBy: 'test' });
      expect(afterRestart.reusedExecution).toBe(true);
      expect(afterRestart.execution.finishedAt).toBe(first.execution.finishedAt);
      expect(listRunStatuses(restarted)).toHaveLength(1);
    } finally {
      for (const directory of [storeRoot, candidate]) rmSync(directory, { recursive: true, force: true });
    }
  }, 180_000);

  it('只冻结未执行的 attempt 状态为 frozen，且仍不给出分数', () => {
    const storeRoot = tempDirectory('fsa-verify-store-');
    const candidate = tempDirectory('fsa-verify-candidate-');
    try {
      exportWorkspace(taskId, candidate);
      const store = createRunStore(storeRoot);
      const envelope = createEnvelope(taskId, candidate, { idempotencyKey: `verify-${randomUUID()}` });
      store.submit({ taskId, envelope, candidateDirectory: candidate, submittedBy: 'test' });
      const status = readRunStatus(store, envelope.runId, envelope.attemptId);
      expect(status.phase).toBe('frozen');
      expect(status.classification).toBeNull();
      expect(status.knownFailures).toEqual([]);
      expect(status.scoring).toEqual({ mode: 'pending', functional: null, quality: null, total: null, reason: '尚未取得受控执行结论，总分待定。' });
    } finally {
      for (const directory of [storeRoot, candidate]) rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('质量证据接入执行档案', () => {
  it('静态规则与评审判决落盘并进入评分，缺 benchmark 客观分时总分保持待定', async () => {
    const storeRoot = tempDirectory('fsa-quality-store-');
    const candidate = tempDirectory('fsa-quality-candidate-');
    try {
      exportWorkspace(taskId, candidate);
      const store = createRunStore(storeRoot);
      const manifest = readManifest(taskId);
      const envelope = createEnvelope(taskId, candidate, { idempotencyKey: `quality-${randomUUID()}` });
      store.submit({ taskId, envelope, candidateDirectory: candidate, submittedBy: 'test' });
      const dimension = () => ({ score: 80, evidence: ['review-1'] });
      const review = {
        schemaVersion: '0.1.0' as const,
        runId: envelope.runId,
        attemptId: envelope.attemptId,
        taskId,
        rubricVersion: '0.1.0',
        model: 'bench-judge-1',
        promptVersion: 'review-v1',
        dimensions: { simplicity: dimension(), maintainability: dimension(), decoupling: dimension(), performance: dimension() },
        notes: ['测试评审'],
        cost: { calls: 1, inputTokens: 10, outputTokens: 5 },
        reviewedAt: '2026-01-01T00:00:00.000Z',
      };
      const outcome = await executeAttempt({
        store, runId: envelope.runId, attemptId: envelope.attemptId,
        staticPolicy: { language: 'typescript', maxDecisionPointsPerFunction: 200, maxFunctionLines: 100000, forbiddenImports: [], evidenceId: 'static-report' },
        review,
      });
      const directory = store.readAttempt(envelope.runId, envelope.attemptId)?.directory ?? '';
      expect(outcome.artifacts.map(item => item.id)).toContain('static.json');
      expect(outcome.artifacts.map(item => item.id)).toContain('review.json');
      expect(outcome.evidenceRefs).toContain('static.json');
      const types = readRunEvents(directory).map(event => event.type);
      expect(types).toContain('static.analyzed');
      expect(types).toContain('review.finished');
      const score = readExecutionScore(directory);
      expect(typeof score?.dimensions.simplicity).toBe('number');
      expect(score?.dimensions.performance).toBeNull();
      expect(score?.quality).toBeNull();
      expect(score?.total).toBeNull();
      expect(score?.reasons.join(' ')).toContain('performance');
      expect(manifest.taskId).toBe(taskId);
    } finally {
      for (const path of [storeRoot, candidate]) rmSync(path, { recursive: true, force: true });
    }
  }, 180_000);
});

describe('静态客观分的运行时适配', () => {
  const report = {
    ruleVersion: '0.1.0',
    evidenceId: 'static-report',
    files: [],
    violations: [],
    scores: { simplicity: 90, maintainability: 80, decoupling: 70 },
  };

  it('typescript 题把三个 static 维度并入客观证据', () => {
    const manifest = { ...readManifest('CACHE-02'), runtime: 'typescript' as const };
    const objective = staticObjectiveFor(manifest, report);
    expect(objective).toMatchObject({
      simplicity: { score: 90, kind: 'static', evidence: ['static-report'] },
      maintainability: { score: 80, kind: 'static' },
      decoupling: { score: 70, kind: 'static' },
    });
  });

  it('非 typescript 题不产出静态客观分，避免用“没有 .ts 文件”的满分冒充质量结论', () => {
    const manifest = { ...readManifest('CACHE-02'), runtime: 'fsharp' as const };
    expect(staticObjectiveFor(manifest, report)).toBeNull();
  });
});
