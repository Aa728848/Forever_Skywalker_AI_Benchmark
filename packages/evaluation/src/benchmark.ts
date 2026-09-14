import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { scoreBenchmark, type BenchmarkPolicy, type BenchmarkSamples } from '@fsa/core';
import { createEnvelope, createRunStore } from '@fsa/runs';
import { executeBenchmarkWorkload, verifySubmission, type QualityProvider } from '@fsa/executor';
import { applyReferencePatch, exportWorkspace, repositoryRoot } from '@fsa/tasks';

type Context = Parameters<QualityProvider>[0];

/** 同一环境交替测量整套受控验证成本；含启动与检查开销，报告不冒称纯函数微基准。 */
export async function measureVerificationCost(context: Context) {
  if (context.execution.classification !== 'passed') throw new Error('候选正确性未通过，不计算性能质量分。');
  const area = join(context.artifactDirectory, 'benchmark-runs');
  mkdirSync(area, { recursive: true });
  const store = createRunStore(join(area, 'runs'));
  const scratch = mkdtempSync(join(tmpdir(), 'fsa-benchmark-'));
  const reference = join(scratch, 'reference');
  const task = context.manifest.task;
  const environmentHash = createHash('sha256').update(JSON.stringify({ environment: context.execution.environment,
    taskVersion: task.taskVersion, commands: task.commands, limits: task.limits })).digest('hex');
  const workloadPath = join(repositoryRoot, 'graders', task.taskId, 'benchmark-policy.json');
  const dedicated = existsSync(workloadPath);
  const declaredPolicy = dedicated ? JSON.parse(readFileSync(workloadPath, 'utf8')) as BenchmarkPolicy : null;
  if (declaredPolicy && (declaredPolicy.warmupRounds !== 2 || declaredPolicy.minimumPairs !== 7)) throw new Error('当前采样器固定使用 2 次预热和 7 轮配对。');
  const policy: BenchmarkPolicy = declaredPolicy ? { ...declaredPolicy, environmentHash, calibrated: declaredPolicy.calibrated && declaredPolicy.environmentHash === environmentHash } : { version: 'verification-cost-v1', environmentHash, calibrated: false, warmupRounds: 2,
    minimumPairs: 7, metrics: [{ id: 'verificationMs', direction: 'lower', good: 1.1, bad: 3, weight: 1 }] };
  const samples: BenchmarkSamples = { evidenceId: 'benchmark-samples', environmentHash, correctnessPassed: true, warmupRounds: 2, pairs: [] };
  const pairs: Array<{ round: number; candidate: Record<string, number>; reference: Record<string, number> }> = [];
  const rawRuns: Array<{ round: number; variant: string; runId: string; attemptId: string; durationMs: number; diagnostic?: unknown }> = [];
  try {
    exportWorkspace(task.taskId, reference);
    const patched = applyReferencePatch(task, reference, join(area, 'patch'));
    if (patched.exitCode !== 0) throw new Error('性能参考补丁无法应用。');
    for (let round = -1; round <= 7; round += 1) {
      context.signal?.throwIfAborted();
      const values: Partial<Record<'candidate' | 'reference', number>> = {};
      const order = round % 2 === 0 ? ['candidate', 'reference'] as const : ['reference', 'candidate'] as const;
      for (const variant of order) {
        const candidateDirectory = variant === 'candidate' ? context.frozenDirectory : reference;
        const envelope = createEnvelope(task.taskId, candidateDirectory, { idempotencyKey: `benchmark-${round}-${variant}` });
        const submission = { store, taskId: task.taskId, envelope, candidateDirectory, submittedBy: 'performance-sampler',
          profile: context.manifest.environment.profile, image: context.manifest.environment.image, imageDigest: context.manifest.environment.imageDigest };
        let durationMs: number;
        let diagnostic: unknown;
        if (dedicated) {
          const frozen = store.submit(submission);
          const sample = await executeBenchmarkWorkload({ store, runId: frozen.attempt.runId, attemptId: frozen.attempt.attemptId,
            artifactDirectory: join(frozen.directory, 'workload'), workspace: join(scratch, `work-${round}-${variant}`), ...(context.signal ? { signal: context.signal } : {}) });
          durationMs = sample.durationMs;
          diagnostic = { output: sample.diagnostic, resource: sample.resource, trust: 'in-process-diagnostic' };
        } else {
          const outcome = await verifySubmission({ ...submission, workspaceDirectory: join(scratch, `work-${round}-${variant}`), ...(context.signal ? { signal: context.signal } : {}) });
          if (outcome.execution.classification !== 'passed') throw new Error(`性能采样 ${variant}/${round} 正确性未通过：${outcome.execution.classification}`);
          durationMs = outcome.execution.phases.reduce((sum, phase) => sum + phase.durationMs, 0);
        }
        if (durationMs <= 0) throw new Error('性能计时精度不足，未取得有效样本。');
        values[variant] = durationMs;
        rawRuns.push({ round, variant, runId: envelope.runId, attemptId: envelope.attemptId, durationMs, ...(diagnostic ? { diagnostic } : {}) });
      }
      const metric = dedicated ? 'durationMs' : 'verificationMs';
      if (round > 0) pairs.push({ round, candidate: { [metric]: values.candidate! }, reference: { [metric]: values.reference! } });
    }
    return { workload: dedicated ? 'task-dedicated-workload' : 'full-verification-cost', includesStartupAndAssertions: true, policy,
      result: scoreBenchmark({ ...samples, pairs }, policy), rawRuns };
  } finally {
    const target = resolve(scratch);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('fsa-benchmark-')) throw new Error('性能临时目录越界。');
    rmSync(target, { recursive: true, force: true });
  }
}
