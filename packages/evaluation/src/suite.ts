import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { tasks, requireTask } from '@fsa/catalog';
import { runSelectionValidator, type SuiteReport } from '@fsa/contracts';
import { summarizeLevels } from '@fsa/core';
import { completedExecutionDirectory, readExecutionResult, readExecutionScore } from '@fsa/executor';
import type { RunStore } from '@fsa/runs';

export function inspectRunSelection(store: RunStore, selection: unknown): {
  selected: SuiteReport['selected'];
  environmentKey: string | null;
  judgeKey: string | null;
  mode: SuiteReport['mode'];
} {
  if (!runSelectionValidator.Check(selection)) throw new Error('请选择 1–55 次明确的作答。');
  const environments = new Set<string>();
  const judgeProfiles = new Set<string>();
  const modes = new Set<string>();
  const selected = selection.map(({ runId, attemptId }) => {
    const outcome = store.readAttempt(runId, attemptId);
    if (!outcome) throw new Error(`未找到作答：${runId}/${attemptId}`);
    const task = requireTask(outcome.attempt.taskId);
    if (outcome.attempt.taskVersion !== task.version) throw new Error(`${task.id} 的题目版本已变更，不能混入当前题库汇总。`);
    const execution = readExecutionResult(outcome.directory);
    const score = readExecutionScore(outcome.directory);
    const revision = completedExecutionDirectory(outcome.directory);
    if (score && (!execution || score.runId !== runId || score.attemptId !== attemptId || score.taskId !== task.id || score.taskVersion !== task.version || score.candidateTreeHash !== outcome.attempt.treeHash || execution.candidateTreeHash !== score.candidateTreeHash)) throw new Error(`${task.id} 的执行、分数与冻结快照不一致。`);
    if (execution) {
      const { profile, imageDigest, platform, platformVersion, containerRuntime } = execution.environment;
      // 题目的资源配额和语言可以不同；操作系统、容器镜像与执行档案必须一致。
      environments.add(createHash('sha256').update(JSON.stringify({ profile, imageDigest, platform, platformVersion, containerRuntime, rubric: score?.rubricVersion ?? '0.1.0' })).digest('hex'));
      modes.add(execution.isolation === 'none' ? 'local' : score?.mode ?? 'pending');
    } else modes.add('pending');
    // 比较已取得质量评审的作答时，推理/采样参数与服务端模型版本也属于固定档案。
    const reviewArtifact = execution?.artifacts.find(artifact => artifact.id === 'review-round-1');
    if (revision && reviewArtifact) {
      const path = realpathSync(resolve(revision, reviewArtifact.path));
      const scope = relative(realpathSync(revision), path);
      if (isAbsolute(scope) || scope.startsWith('..')) throw new Error('裁判证据越过运行目录。');
      const bytes = readFileSync(path);
      if (createHash('sha256').update(bytes).digest('hex') !== reviewArtifact.sha256) throw new Error('裁判证据摘要不一致。');
      const record = JSON.parse(bytes.toString('utf8')) as { configuration?: { parametersFingerprint?: string }; responseModel?: string; dshSession?: { version: string; presetFingerprint: string } };
      judgeProfiles.add(JSON.stringify([record.configuration?.parametersFingerprint ?? 'unrecorded', record.responseModel ?? 'unreported',
        ...(record.dshSession ? [record.dshSession.version, record.dshSession.presetFingerprint] : [])]));
    } else if (score?.total !== null && score?.total !== undefined) judgeProfiles.add('unrecorded');
    return { runId, attemptId, taskId: task.id, taskVersion: task.version, track: task.track, scoreRevision: revision ? basename(revision) : null,
      scoredAt: score?.scoredAt ?? null, total: score?.total ?? null, thresholdMet: score?.thresholdMet ?? null };
  });
  if (environments.size > 1) throw new Error('所选作答的环境或评分规则不同，请分开汇总 Linux、Windows 和不同镜像的结果。');
  if (judgeProfiles.size > 1) throw new Error('所选作答的裁判参数或实际模型版本不同，请分开汇总。');
  const mode: SuiteReport['mode'] = modes.has('local') ? 'local' : modes.has('rehearsal') ? 'rehearsal' : modes.has('pending') ? 'pending' : 'formal';
  return { selected, environmentKey: [...environments][0] ?? null, judgeKey: [...judgeProfiles][0] ?? null, mode };
}

export function summarizeRuns(store: RunStore, selection: unknown): SuiteReport {
  const { selected, environmentKey, mode } = inspectRunSelection(store, selection);
  const levels = summarizeLevels(tasks, selected.map(item => ({ taskId: item.taskId, result: item })));
  return { ...levels, mode, generatedAt: new Date().toISOString(), environmentKey, selected };
}
