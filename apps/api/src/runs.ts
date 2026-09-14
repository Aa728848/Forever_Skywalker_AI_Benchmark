import { existsSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { RunStatus, RunSubmission } from '@fsa/contracts';
import { createEnvelope, createRunStore, defaultRunRoot } from '@fsa/runs';
import { listRunStatuses, readRunStatus, verifySubmission } from '@fsa/executor';

/** 正式运行入口：需要提交根目录与访问令牌同时配置才会启用。 */
export interface RunEntryOptions {
  runRoot?: string;
  submissionsRoot?: string | null;
  token?: string | null;
  /** 平台统一的执行档案：容器档案必须同时给出镜像引用与 digest。 */
  profile?: 'local' | 'linux-container';
  image?: string | null;
  imageDigest?: string | null;
}

export interface RunEntry {
  readonly enabled: boolean;
  readonly disabledReason: string | null;
  submit(submission: RunSubmission): Promise<RunStatus>;
  status(runId: string, attemptId: string): RunStatus;
  list(): RunStatus[];
}

export function openRunEntry(options: RunEntryOptions = {}): RunEntry {
  const store = createRunStore(options.runRoot ?? defaultRunRoot);
  const submissionsRoot = options.submissionsRoot ?? null;
  const token = options.token ?? null;
  const disabledReason = submissionsRoot === null
    ? '正式提交入口未启用：未配置 BENCH_SUBMISSIONS_DIR。'
    : token === null
      ? '正式提交入口未启用：未配置 BENCH_RUN_TOKEN。'
      : null;

  const resolveCandidate = (candidate: string): string => {
    if (submissionsRoot === null) throw new Error('正式提交入口未启用：未配置提交根目录。');
    const root = resolve(submissionsRoot);
    const target = resolve(root, candidate);
    const scope = relative(root, target);
    if (scope === '' || scope.startsWith('..') || isAbsolute(scope)) {
      throw new Error(`候选目录必须位于提交根目录内：${candidate}`);
    }
    if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error(`候选目录不存在：${candidate}`);
    return target;
  };

  return {
    enabled: disabledReason === null,
    disabledReason,
    async submit(submission: RunSubmission): Promise<RunStatus> {
      if (disabledReason !== null) throw new Error(disabledReason);
      const candidateDirectory = resolveCandidate(submission.candidateDirectory);
      const envelope = createEnvelope(submission.taskId, candidateDirectory, {
        idempotencyKey: submission.idempotencyKey,
        reason: submission.reason,
      });
      const outcome = await verifySubmission({
        store,
        taskId: submission.taskId,
        envelope,
        candidateDirectory,
        submittedBy: submission.submittedBy,
        ...(options.profile === undefined ? {} : { profile: options.profile }),
        ...(options.image === undefined ? {} : { image: options.image }),
        ...(options.imageDigest === undefined ? {} : { imageDigest: options.imageDigest }),
      });
      return readRunStatus(store, outcome.submission.attempt.runId, outcome.submission.attempt.attemptId);
    },
    status(runId: string, attemptId: string): RunStatus {
      return readRunStatus(store, runId, attemptId);
    },
    list(): RunStatus[] {
      return listRunStatuses(store);
    },
  };
}
