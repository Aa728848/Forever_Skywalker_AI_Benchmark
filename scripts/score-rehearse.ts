import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sampleVerdict, type ReviewRequest } from '../packages/judge/src/index.ts';
import { applyReferencePatch, exportWorkspace, readManifest, repositoryRoot } from '../packages/tasks/src/index.ts';
import { createEnvelope, createRunStore } from '../packages/runs/src/index.ts';
import { readExecutionScore, readRunStatus, verifySubmission } from '../packages/executor/src/index.ts';
import type { StaticPolicy } from '../packages/static/src/index.ts';

/**
 * 正式分数演练：导出 CACHE-02 → 应用参考补丁 → 提交 → 执行，并注入静态规则、脚本评审与
 * 一个显式标注的 benchmark 客观分，演示「可用验证 + 质量 + 总分」齐全的正式分数。
 * 脚本评审与 benchmark 分是演练输入，不是真实模型或真实基准成绩。
 */
const taskId = 'CACHE-02';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const store = createRunStore(join(repositoryRoot, 'data', 'score-rehearsal', stamp));
const candidate = mkdtempSync(join(tmpdir(), 'fsa-score-'));
const manifest = readManifest(taskId);
try {
  exportWorkspace(taskId, candidate);
  const applied = applyReferencePatch(manifest, candidate, join(repositoryRoot, 'data', 'score-rehearsal', 'raw'));
  if (applied.exitCode !== 0) throw new Error('参考补丁应用失败：' + applied.stderr);
  const envelope = createEnvelope(taskId, candidate, { idempotencyKey: 'score-rehearsal-' + stamp });
  const request: ReviewRequest = { runId: envelope.runId, attemptId: envelope.attemptId, taskId, promptVersion: 'review-v1', materials: [] };
  const review = sampleVerdict(request, { simplicity: 85, maintainability: 80, decoupling: 90, performance: 75 }, ['review-material-1'], 'scripted-rehearsal-judge', 'review-v1');
  const policy: StaticPolicy = {
    language: 'typescript',
    maxDecisionPointsPerFunction: 12,
    maxFunctionLines: 60,
    forbiddenImports: ['node:child_process'],
    evidenceId: 'static-report',
  };
  const outcome = await verifySubmission({
    store,
    taskId,
    envelope,
    candidateDirectory: candidate,
    submittedBy: 'rehearsal',
    staticPolicy: policy,
    review,
    quality: { objective: { performance: { score: 88, evidence: ['benchmark-rehearsal'], kind: 'benchmark' } } },
  });
  const status = readRunStatus(store, outcome.submission.attempt.runId, outcome.submission.attempt.attemptId);
  const score = readExecutionScore(outcome.submission.directory);
  console.log('执行结论：' + outcome.execution.classification + '（隔离 ' + outcome.execution.isolation + '）');
  console.log('可用验证：' + score?.functional + ' / 50');
  console.log('质量维度：' + JSON.stringify(score?.dimensions));
  console.log('代码质量：' + score?.quality + ' / 50');
  console.log('总分：' + score?.total + ' / 100，门槛：' + String(score?.thresholdMet));
  console.log('运行状态摘要：' + JSON.stringify(status.scoring));
  console.log('证据引用：' + (score?.evidenceRefs ?? []).join('、'));
  console.log('理由：' + (score?.reasons ?? []).join(' / '));
} finally {
  rmSync(candidate, { recursive: true, force: true });
}
