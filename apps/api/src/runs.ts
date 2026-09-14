import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { HumanReview, RunDetail, RunStatus, RunSubmission } from '@fsa/contracts';
import { createEnvelope, createRunStore, defaultRunRoot, readRunEvents } from '@fsa/runs';
import { completedExecutionDirectory, listRunStatuses, readExecutionResult, readExecutionScore, readRunStatus, renderRunReport, retryCompletedAttempt, reviewCompletedAttempt, verifySubmission, type QualityProvider } from '@fsa/executor';
import { createQualityProvider } from '@fsa/evaluation';

/** 正式运行入口：需要提交根目录与访问令牌同时配置才会启用。 */
export interface RunEntryOptions {
  runRoot?: string;
  submissionsRoot?: string | null;
  token?: string | null;
  /** 平台统一的执行档案：容器档案必须同时给出镜像引用与 digest。 */
  profile?: 'local' | 'linux-container';
  image?: string | null;
  imageDigest?: string | null;
  qualityProvider?: QualityProvider;
}

export interface RunEntry {
  readonly enabled: boolean;
  readonly disabledReason: string | null;
  submit(submission: RunSubmission): Promise<RunStatus>;
  status(runId: string, attemptId: string): RunStatus;
  report(runId: string, attemptId: string): string;
  list(): RunStatus[];
  detail(runId: string, attemptId: string): RunDetail;
  artifact(runId: string, attemptId: string, id: string): Buffer;
  review(runId: string, attemptId: string, human?: HumanReview): Promise<RunStatus>;
  retry(runId: string, attemptId: string): Promise<RunStatus>;
  cancel(runId: string, attemptId: string): boolean;
  close(): Promise<void>;
}

export function openRunEntry(options: RunEntryOptions = {}): RunEntry {
  const store = createRunStore(options.runRoot ?? defaultRunRoot);
  const submissionsRoot = options.submissionsRoot ?? null;
  const token = options.token ?? null;
  const disabledReason = submissionsRoot === null || submissionsRoot.trim() === ''
    ? '正式提交入口未启用：未配置 BENCH_SUBMISSIONS_DIR。'
    : token === null || token.trim() === ''
      ? '正式提交入口未启用：未配置 BENCH_RUN_TOKEN。'
      : null;
  const qualityProvider = options.qualityProvider ?? createQualityProvider();
  const active = new Map<string, { controller: AbortController; promise: Promise<RunStatus> }>();

  const resolveCandidate = (candidate: string): string => {
    if (submissionsRoot === null) throw new Error('正式提交入口未启用：未配置提交根目录。');
    const root = realpathSync(resolve(submissionsRoot));
    const requested = resolve(root, candidate);
    if (!existsSync(requested)) throw new Error(`候选目录不存在：${candidate}`);
    const target = realpathSync(requested);
    const scope = relative(root, target);
    if (scope === '' || scope === '..' || scope.startsWith('..\\') || scope.startsWith('../') || isAbsolute(scope)) {
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
      const frozen = store.submit({
        taskId: submission.taskId, envelope, candidateDirectory, submittedBy: submission.submittedBy,
        ...(options.profile === undefined ? {} : { profile: options.profile }),
        ...(options.image === undefined ? {} : { image: options.image }),
        ...(options.imageDigest === undefined ? {} : { imageDigest: options.imageDigest }),
      });
      const key = `${frozen.attempt.runId}/${frozen.attempt.attemptId}`;
      const existing = active.get(key);
      if (existing) return existing.promise;
      const controller = new AbortController();
      const pending = verifySubmission({
        store,
        taskId: submission.taskId,
        envelope,
        candidateDirectory,
        submittedBy: submission.submittedBy,
        signal: controller.signal,
        qualityProvider,
        ...(options.profile === undefined ? {} : { profile: options.profile }),
        ...(options.image === undefined ? {} : { image: options.image }),
        ...(options.imageDigest === undefined ? {} : { imageDigest: options.imageDigest }),
      }).then(outcome => readRunStatus(store, outcome.submission.attempt.runId, outcome.submission.attempt.attemptId));
      active.set(key, { controller, promise: pending });
      try { return await pending; }
      finally { active.delete(key); }
    },
    status(runId: string, attemptId: string): RunStatus {
      return readRunStatus(store, runId, attemptId);
    },
    report(runId: string, attemptId: string): string {
      return renderRunReport(store, runId, attemptId);
    },
    list(): RunStatus[] {
      return listRunStatuses(store);
    },
    detail(runId, attemptId) {
      const outcome = store.readAttempt(runId, attemptId);
      if (!outcome) throw new Error('未找到运行记录。');
      return { status: readRunStatus(store, runId, attemptId), execution: readExecutionResult(outcome.directory), score: readExecutionScore(outcome.directory), events: readRunEvents(outcome.directory) };
    },
    artifact(runId, attemptId, id) {
      const outcome = store.readAttempt(runId, attemptId);
      if (!outcome) throw new Error('未找到运行记录。');
      const directory = completedExecutionDirectory(outcome.directory);
      const metadata = readExecutionResult(outcome.directory)?.artifacts.find(item => item.id === id);
      if (!directory || !metadata) throw new Error('证据不存在。');
      const path = realpathSync(join(directory, metadata.path));
      const scope = relative(realpathSync(directory), path);
      if (isAbsolute(scope) || scope.startsWith('..')) throw new Error('证据路径越界。');
      const bytes = readFileSync(path);
      if (createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) throw new Error('证据内容摘要不符，拒绝下载。');
      return bytes;
    },
    async review(runId, attemptId, human) {
      if (active.has(`${runId}/${attemptId}`)) throw new Error('运行尚未结束，不能重评。');
      const frozen = store.readAttempt(runId, attemptId);
      if (!frozen) throw new Error('未找到运行记录。');
      if (human && (human.verdict.runId !== runId || human.verdict.attemptId !== attemptId || human.verdict.taskId !== frozen.attempt.taskId)) throw new Error('人工复核与指定作答不一致。');
      const key = `${runId}/${attemptId}`;
      const controller = new AbortController();
      const pending = reviewCompletedAttempt({ store, runId, attemptId, signal: controller.signal, qualityProvider: human === undefined ? qualityProvider : createQualityProvider({ humanReview: human }) })
        .then(() => readRunStatus(store, runId, attemptId));
      active.set(key, { controller, promise: pending });
      try { return await pending; } finally { active.delete(key); }
    },
    async retry(runId, attemptId) {
      const key = `${runId}/${attemptId}`;
      const existing = active.get(key);
      if (existing) return existing.promise;
      const controller = new AbortController();
      const pending = retryCompletedAttempt({ store, runId, attemptId, signal: controller.signal, qualityProvider })
        .then(() => readRunStatus(store, runId, attemptId));
      active.set(key, { controller, promise: pending });
      try { return await pending; } finally { active.delete(key); }
    },
    cancel(runId, attemptId) {
      const task = active.get(`${runId}/${attemptId}`);
      if (!task) return false;
      task.controller.abort(new Error('操作者取消本次执行。'));
      return true;
    },
    async close() {
      for (const task of active.values()) task.controller.abort(new Error('运行服务正在关闭。'));
      await Promise.allSettled([...active.values()].map(task => task.promise));
    },
  };
}
