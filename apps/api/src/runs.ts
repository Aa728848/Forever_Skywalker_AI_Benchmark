import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { HumanReview, RunDetail, RunStatus, RunSubmission } from '@fsa/contracts';
import { createEnvelope, createRunStore, defaultRunRoot, readRunEvents } from '@fsa/runs';
import { completedExecutionDirectory, listRunStatuses, readExecutionResult, readExecutionScore, readRunStatus, renderRunReport, retryCompletedAttempt, reviewCompletedAttempt, verifySubmission, type QualityProvider } from '@fsa/executor';
import { createQualityProvider } from '@fsa/evaluation';

/**
 * 质量证据提供者工厂：每次操作按当时的有效配置构造，因此裁判/性能测量配置保存后立即生效。
 * 传入工厂而不是实例，是这里唯一的正确形状——一个已构造的 provider 会永久冻结旧配置。
 */
export type QualityProviderFactory = (env: NodeJS.ProcessEnv) => QualityProvider;

/** 正式运行入口的配置来源。 */
export interface RunEntryOptions {
  /**
   * 运行记录根目录。启动时固定，不随配置改动：它决定既有 run 记录的物理位置，
   * 改动会让历史记录消失。只读暴露给 /api/config。
   */
  runRoot?: string;
  /** 当前配置来源；每次操作重新读取，保存配置后无需重启即生效。 */
  config?: { current(): NodeJS.ProcessEnv };
  /** 显式覆盖项（优先于 config）：CLI 与测试注入固定值。 */
  submissionsRoot?: string | null;
  token?: string | null;
  profile?: 'local' | 'linux-container';
  image?: string | null;
  imageDigest?: string | null;
  qualityProvider?: QualityProviderFactory;
}

/**
 * 正式运行入口。
 * enabled / disabledReason / profile / image / imageDigest / token 都是函数：
 * 它们在每次操作时按当前配置求值，而不是在 openRunEntry 时固定一次。
 */
export interface RunEntry {
  /** 固定不变的运行记录根（BENCH_RUN_DIR），只读。 */
  readonly runRoot: string;
  enabled(): boolean;
  disabledReason(): string | null;
  profile(): 'local' | 'linux-container';
  image(): string | null;
  imageDigest(): string | null;
  token(): string | null;
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

const present = (value: string | null | undefined): value is string => value !== null && value !== undefined && value.trim() !== '';

export function openRunEntry(options: RunEntryOptions = {}): RunEntry {
  // runRoot 在启动时固定；其余配置全部按操作求值。
  const runRoot = options.runRoot ?? defaultRunRoot;
  const store = createRunStore(runRoot);
  const env = (): NodeJS.ProcessEnv => options.config?.current() ?? process.env;
  const pick = <T>(explicit: T | undefined, read: () => T): T => explicit === undefined ? read() : explicit;

  const submissionsRoot = (): string | null => pick(options.submissionsRoot, () => env().BENCH_SUBMISSIONS_DIR ?? null);
  const token = (): string | null => pick(options.token, () => env().BENCH_RUN_TOKEN ?? null);
  const profile = (): 'local' | 'linux-container' => pick(options.profile, () => env().BENCH_PROFILE === 'linux-container' ? 'linux-container' : 'local');
  const image = (): string | null => pick(options.image, () => env().BENCH_IMAGE ?? null);
  const imageDigest = (): string | null => pick(options.imageDigest, () => env().BENCH_IMAGE_DIGEST ?? null);

  const disabledReason = (): string | null => {
    const root = submissionsRoot();
    if (!present(root)) return '正式提交入口未启用：未配置 BENCH_SUBMISSIONS_DIR。';
    return present(token()) ? null : '正式提交入口未启用：未配置 BENCH_RUN_TOKEN。';
  };
  /** 每次操作以当前配置构造；不缓存实例，避免把旧配置冻结进运行。 */
  const quality = (): QualityProvider => options.qualityProvider?.(env()) ?? createQualityProvider({ env: env() });
  const active = new Map<string, { controller: AbortController; promise: Promise<RunStatus> }>();

  const resolveCandidate = (candidate: string): string => {
    const configured = submissionsRoot();
    if (!present(configured)) throw new Error('正式提交入口未启用：未配置提交根目录。');
    const root = realpathSync(resolve(configured));
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

  /** 本次操作使用的档案与镜像：按当前配置求值后传入冻结与执行链路。 */
  const environment = (): { profile: 'local' | 'linux-container'; image: string | null; imageDigest: string | null } =>
    ({ profile: profile(), image: image(), imageDigest: imageDigest() });

  return {
    runRoot,
    enabled: () => disabledReason() === null,
    disabledReason,
    profile,
    image,
    imageDigest,
    token,
    async submit(submission: RunSubmission): Promise<RunStatus> {
      const reason = disabledReason();
      if (reason !== null) throw new Error(reason);
      const candidateDirectory = resolveCandidate(submission.candidateDirectory);
      const current = environment();
      const envelope = createEnvelope(submission.taskId, candidateDirectory, {
        idempotencyKey: submission.idempotencyKey,
        reason: submission.reason,
      });
      const frozen = store.submit({
        taskId: submission.taskId, envelope, candidateDirectory, submittedBy: submission.submittedBy,
        profile: current.profile,
        image: current.image,
        imageDigest: current.imageDigest,
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
        qualityProvider: quality(),
        profile: current.profile,
        image: current.image,
        imageDigest: current.imageDigest,
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
      const pending = reviewCompletedAttempt({ store, runId, attemptId, signal: controller.signal, qualityProvider: human === undefined ? quality() : createQualityProvider({ env: env(), humanReview: human }) })
        .then(() => readRunStatus(store, runId, attemptId));
      active.set(key, { controller, promise: pending });
      try { return await pending; } finally { active.delete(key); }
    },
    async retry(runId, attemptId) {
      const key = `${runId}/${attemptId}`;
      const existing = active.get(key);
      if (existing) return existing.promise;
      const controller = new AbortController();
      const pending = retryCompletedAttempt({ store, runId, attemptId, signal: controller.signal, qualityProvider: quality() })
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
