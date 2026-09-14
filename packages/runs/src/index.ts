import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  executionManifestValidator, frozenAttemptValidator, runEventValidator, runIndexValidator, submissionEnvelopeValidator,
  type ExecutionManifest, type FrozenAttempt, type RunEvent, type RunIndex, type SubmissionEnvelope, type TaskManifest,
} from '@fsa/contracts';
import { exportWorkspace, readManifest, repositoryRoot } from '@fsa/tasks';

/**
 * 提交与冻结控制面：平台自己重算候选摘要、按幂等键记录提交，并把冻结快照作为唯一被测对象。
 * 本模块只信任自己复算的结果；候选自报的摘要与基线只作为待核对声明。
 */
export const defaultRunRoot = join(repositoryRoot, 'data', 'runs');
/** 冻结时排除的目录名：VCS 元数据与依赖树不属于候选源码，且会一并写入冻结记录。 */
export const defaultExcluded = ['.git', 'node_modules'];

export type ExecutionProfile = 'local' | 'linux-container';
type IndexEntry = RunIndex['entries'][number];

export class SubmissionRejectedError extends Error {}
export class CandidateHashMismatchError extends SubmissionRejectedError {
  readonly reported: string;
  readonly computed: string;
  constructor(reported: string, computed: string) {
    super(`候选自报摘要与平台实算不一致：自报 ${reported}，实算 ${computed}`);
    this.reported = reported;
    this.computed = computed;
  }
}
export class IdempotencyConflictError extends SubmissionRejectedError {}
export class AttemptExistsError extends SubmissionRejectedError {}
export class FrozenSnapshotTamperedError extends Error {}

export interface FrozenFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface TreeDigest {
  treeHash: string;
  fileCount: number;
  bytes: number;
  files: FrozenFile[];
}

function isExcluded(name: string, excluded: ReadonlySet<string>): boolean {
  return excluded.has(name);
}

function walkTree(root: string, excluded: ReadonlySet<string>, visit: (absolute: string, relativePath: string) => void): void {
  const step = (directory: string): void => {
    for (const child of readdirSync(directory).sort()) {
      if (isExcluded(child, excluded)) continue;
      const absolute = join(directory, child);
      const path = relative(root, absolute).split(sep).join('/');
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`候选树不得包含符号链接：${path}`);
      if (stat.isDirectory()) {
        step(absolute);
        continue;
      }
      if (!stat.isFile()) throw new Error(`候选树包含不支持的文件类型：${path}`);
      visit(absolute, path);
    }
  };
  step(root);
}

/** 规范化树摘要：按路径排序，逐文件内容哈希，再对清单求摘要；与文件系统时间无关。 */
export function digestTree(directory: string, options: { excluded?: readonly string[] } = {}): TreeDigest {
  const excluded = new Set(options.excluded ?? defaultExcluded);
  const files: FrozenFile[] = [];
  walkTree(directory, excluded, (absolute, path) => {
    const content = readFileSync(absolute);
    files.push({ path, sha256: createHash('sha256').update(content).digest('hex'), bytes: content.byteLength });
  });
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const manifest = createHash('sha256');
  for (const file of files) manifest.update(`${file.path}\u0000${file.sha256}\u0000${file.bytes}\n`, 'utf8');
  return {
    treeHash: manifest.digest('hex'),
    fileCount: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files,
  };
}

function copyTree(source: string, target: string, excluded: ReadonlySet<string>): void {
  mkdirSync(target, { recursive: true });
  walkTree(source, excluded, (absolute, path) => {
    const destination = join(target, ...path.split('/'));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(absolute, destination);
  });
}

/** Windows 上刚写完的目录可能被杀毒或索引服务短暂占用，rename 需要有限重试。 */
function sleepSync(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function renameWithRetry(from: string, to: string): void {
  const delays = [0, 20, 50, 100, 200, 400];
  let lastError: unknown = null;
  for (const delay of delays) {
    sleepSync(delay);
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as { code?: string }).code ?? '';
      if (!['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(code)) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('重命名目标目录失败。');
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson<T>(path: string, check: { Check(value: unknown): boolean }, label: string): T {
  if (!existsSync(path)) throw new Error(`缺少${label}：${path}`);
  const input: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!check.Check(input)) throw new Error(`${label} 不符合 0.1.0 协议：${path}`);
  return input as T;
}

/** 当前题目包的导出基线摘要：候选必须从这一份基线出发。 */
export function submissionBaseline(taskId: string): string {
  const staging = mkdtempSync(join(tmpdir(), `fsa-baseline-${taskId.toLowerCase()}-`));
  try {
    exportWorkspace(taskId, staging);
    return digestTree(staging).treeHash;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export interface EnvelopeOptions {
  runId?: string;
  attemptId?: string;
  idempotencyKey?: string;
  reason?: SubmissionEnvelope['reason'];
}

/**
 * 生成提交信封。baseCommit 与 candidateTreeHash 由平台按当前题目包基线与候选目录实算，
 * 调用方仍可在提交时改写声明值以检验平台的核对逻辑。
 */
export function createEnvelope(taskId: string, candidateDirectory: string, options: EnvelopeOptions = {}): SubmissionEnvelope {
  const task = readManifest(taskId);
  const digest = digestTree(resolve(candidateDirectory), { excluded: defaultExcluded });
  return {
    schemaVersion: '0.1.0',
    runId: options.runId ?? `run-${randomUUID()}`,
    attemptId: options.attemptId ?? `attempt-${randomUUID()}`,
    taskId,
    taskVersion: task.taskVersion,
    baseCommit: submissionBaseline(taskId),
    candidateTreeHash: digest.treeHash,
    idempotencyKey: options.idempotencyKey ?? `submit-${randomUUID()}`,
    reason: options.reason ?? 'operator-submit',
  };
}

export const eventsFileName = 'events.jsonl';

export interface RunEventInput {
  type: RunEvent['type'];
  actor: string;
  candidateHash: string;
  payload?: Record<string, unknown>;
  evidenceRefs?: string[];
  /** 稳定事件 ID：同 ID 只追加一次，重复完成事件不会重复记账。 */
  id?: string;
  at?: string;
}

/** 读取 attempt 的事件流（按追加顺序）。 */
export function readRunEvents(attemptDirectory: string): RunEvent[] {
  const path = join(attemptDirectory, eventsFileName);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter(line => line.trim() !== '')
    .map(line => {
      const parsed: unknown = JSON.parse(line);
      if (!runEventValidator.Check(parsed)) throw new Error('运行事件不符合 0.1.0 协议。');
      return parsed;
    });
}

/** 追加一条控制面事件；seq 单调递增，同 ID 幂等。 */
export function appendRunEvent(attemptDirectory: string, input: RunEventInput): RunEvent {
  const id = input.id ?? input.type + ':' + input.candidateHash.slice(0, 16) + ':' + input.actor;
  const existing = readRunEvents(attemptDirectory);
  const duplicate = existing.find(event => event.id === id);
  if (duplicate !== undefined) return duplicate;
  const last = existing[existing.length - 1];
  const event: RunEvent = {
    schemaVersion: '0.1.0',
    id,
    seq: last === undefined ? 1 : last.seq + 1,
    at: input.at ?? new Date().toISOString(),
    type: input.type,
    actor: input.actor,
    candidateHash: input.candidateHash,
    payload: input.payload ?? {},
    evidenceRefs: input.evidenceRefs ?? [],
  };
  appendFileSync(join(attemptDirectory, eventsFileName), JSON.stringify(event) + '\n');
  return event;
}

export interface SubmitRequest {
  taskId: string;
  envelope: unknown;
  candidateDirectory: string;
  submittedBy: string;
  profile?: ExecutionProfile;
  image?: string | null;
  imageDigest?: string | null;
  submittedAt?: string;
}

export interface SubmissionOutcome {
  outcome: 'created' | 'reused';
  attempt: FrozenAttempt;
  manifest: ExecutionManifest;
  directory: string;
}

export interface MaterializedCandidate {
  directory: string;
  treeHash: string;
  fileCount: number;
}

export interface RunStore {
  readonly root: string;
  readonly excluded: readonly string[];
  submit(request: SubmitRequest): SubmissionOutcome;
  read(idempotencyKey: string): SubmissionOutcome | null;
  readAttempt(runId: string, attemptId: string): SubmissionOutcome | null;
  list(): readonly IndexEntry[];
  materialize(runId: string, attemptId: string, destination: string): MaterializedCandidate;
}

export function createRunStore(root: string = defaultRunRoot, options: { excluded?: readonly string[] } = {}): RunStore {
  const storeRoot = resolve(root);
  const excluded = [...(options.excluded ?? defaultExcluded)];
  const excludedSet = new Set(excluded);
  const indexPath = join(storeRoot, 'index.json');

  const readIndex = (): RunIndex => {
    if (!existsSync(indexPath)) return { schemaVersion: '0.1.0', entries: [] };
    return readJson<RunIndex>(indexPath, runIndexValidator, '运行索引');
  };

  const writeIndex = (index: RunIndex): void => {
    mkdirSync(storeRoot, { recursive: true });
    const temporary = `${indexPath}.tmp`;
    writeJson(temporary, index);
    renameWithRetry(temporary, indexPath);
  };

  const attemptDirectory = (taskId: string, runId: string, attemptId: string): string => join(storeRoot, taskId, runId, attemptId);
  const relativePathOf = (absolute: string): string => relative(storeRoot, absolute).split(sep).join('/');

  const outcomeOf = (entry: IndexEntry): SubmissionOutcome => {
    const directory = attemptDirectory(entry.taskId, entry.runId, entry.attemptId);
    return {
      outcome: 'reused',
      attempt: readJson<FrozenAttempt>(join(directory, 'freeze.json'), frozenAttemptValidator, '冻结记录'),
      manifest: readJson<ExecutionManifest>(join(directory, 'manifest.json'), executionManifestValidator, '执行 manifest'),
      directory,
    };
  };

  const buildManifest = (
    task: TaskManifest,
    envelope: SubmissionEnvelope,
    frozen: FrozenAttempt,
    taskPackageHash: string,
    profile: ExecutionProfile,
    image: string | null,
    imageDigest: string | null,
    workingDirectory: string,
  ): ExecutionManifest => ({
    schemaVersion: '0.1.0',
    runId: envelope.runId,
    attemptId: envelope.attemptId,
    ruleVersion: '0.1.0',
    task,
    environment: { profile, runtimeRange: task.runtimeRange, image, imageDigest, network: false, workingDirectory },
    candidate: {
      directory: frozen.directory,
      treeHash: frozen.treeHash,
      taskPackageHash,
      fileCount: frozen.fileCount,
      bytes: frozen.bytes,
      excluded: frozen.excluded,
    },
    envelope,
  });

  return {
    root: storeRoot,
    excluded,

    submit(request: SubmitRequest): SubmissionOutcome {
      const task = readManifest(request.taskId);
      if (!submissionEnvelopeValidator.Check(request.envelope)) throw new SubmissionRejectedError('提交信封不符合 0.1.0 协议。');
      const envelope = request.envelope;
      if (envelope.taskId !== request.taskId) throw new SubmissionRejectedError(`提交信封的题目与请求不一致：${envelope.taskId}`);
      if (envelope.taskVersion !== task.taskVersion) throw new SubmissionRejectedError(`提交信封的题目版本与当前题目包不一致：${envelope.taskVersion}`);
      if (request.submittedBy.trim() === '') throw new SubmissionRejectedError('提交者不能为空。');

      const profile = request.profile ?? 'local';
      const image = request.image ?? null;
      const imageDigest = request.imageDigest ?? null;
      if (profile === 'linux-container' && (image === null || imageDigest === null)) {
        throw new SubmissionRejectedError('linux-container 档案必须同时固定镜像引用与镜像 digest。');
      }

      const candidate = resolve(request.candidateDirectory);
      if (!existsSync(candidate) || !statSync(candidate).isDirectory()) throw new SubmissionRejectedError(`候选目录不存在：${candidate}`);

      const baseline = submissionBaseline(request.taskId);
      if (envelope.baseCommit !== baseline) {
        throw new SubmissionRejectedError(`提交基线不是当前题目包导出基线：声明 ${envelope.baseCommit}，当前 ${baseline}`);
      }

      const digest = digestTree(candidate, { excluded });
      if (digest.treeHash !== envelope.candidateTreeHash) {
        throw new CandidateHashMismatchError(envelope.candidateTreeHash, digest.treeHash);
      }

      const index = readIndex();
      const known = index.entries.find(entry => entry.idempotencyKey === envelope.idempotencyKey);
      if (known !== undefined) {
        if (known.taskId !== request.taskId) throw new IdempotencyConflictError(`幂等键已用于其它题目：${known.taskId}`);
        if (known.treeHash !== digest.treeHash) {
          throw new IdempotencyConflictError(`同一幂等键收到不同快照：已冻结 ${known.treeHash}，本次 ${digest.treeHash}`);
        }
        return outcomeOf(known);
      }

      const finalDirectory = attemptDirectory(request.taskId, envelope.runId, envelope.attemptId);
      if (existsSync(finalDirectory)) {
        throw new AttemptExistsError(`attempt 已冻结，不能覆盖：${relativePathOf(finalDirectory)}`);
      }
      const staging = `${finalDirectory}.partial`;
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      try {
        const frozenDirectory = join(staging, 'candidate');
        copyTree(candidate, frozenDirectory, excludedSet);
        const copied = digestTree(frozenDirectory, { excluded });
        if (copied.treeHash !== digest.treeHash) {
          throw new Error(`冻结副本摘要与收取内容不一致：收取 ${digest.treeHash}，副本 ${copied.treeHash}`);
        }
        const frozenAt = new Date().toISOString();
        const frozen: FrozenAttempt = {
          schemaVersion: '0.1.0',
          runId: envelope.runId,
          attemptId: envelope.attemptId,
          taskId: request.taskId,
          taskVersion: envelope.taskVersion,
          idempotencyKey: envelope.idempotencyKey,
          baseCommit: envelope.baseCommit,
          reason: envelope.reason,
          submittedBy: request.submittedBy,
          submittedAt: request.submittedAt ?? frozenAt,
          frozenAt,
          selfReportedTreeHash: envelope.candidateTreeHash,
          treeHash: digest.treeHash,
          directory: relativePathOf(join(finalDirectory, 'candidate')),
          excluded,
          fileCount: digest.fileCount,
          bytes: digest.bytes,
          files: digest.files,
        };
        const manifest = buildManifest(
          task, envelope, frozen, baseline, profile, image, imageDigest,
          relativePathOf(join(finalDirectory, 'workspace')),
        );
        writeJson(join(staging, 'envelope.json'), envelope);
        writeJson(join(staging, 'freeze.json'), frozen);
        writeJson(join(staging, 'manifest.json'), manifest);
        renameWithRetry(staging, finalDirectory);
        appendRunEvent(finalDirectory, {
          type: 'run.created',
          actor: request.submittedBy,
          candidateHash: digest.treeHash,
          payload: { taskId: request.taskId, taskVersion: task.taskVersion, profile, reason: envelope.reason },
          id: 'run.created:' + envelope.runId,
          at: frozenAt,
        });
        appendRunEvent(finalDirectory, {
          type: 'submission.frozen',
          actor: request.submittedBy,
          candidateHash: digest.treeHash,
          payload: { idempotencyKey: envelope.idempotencyKey, baseCommit: envelope.baseCommit, files: digest.fileCount, bytes: digest.bytes },
          evidenceRefs: ['freeze.json', 'envelope.json'],
          id: 'submission.frozen:' + envelope.runId + ':' + envelope.attemptId,
          at: frozenAt,
        });
        writeIndex({
          schemaVersion: '0.1.0',
          entries: [...index.entries, {
            idempotencyKey: envelope.idempotencyKey,
            taskId: request.taskId,
            runId: envelope.runId,
            attemptId: envelope.attemptId,
            treeHash: digest.treeHash,
            frozenAt,
          }],
        });
        return { outcome: 'created', attempt: frozen, manifest, directory: finalDirectory };
      } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        throw error;
      }
    },

    read(idempotencyKey: string): SubmissionOutcome | null {
      const entry = readIndex().entries.find(item => item.idempotencyKey === idempotencyKey);
      return entry === undefined ? null : outcomeOf(entry);
    },

    readAttempt(runId: string, attemptId: string): SubmissionOutcome | null {
      const entry = readIndex().entries.find(item => item.runId === runId && item.attemptId === attemptId);
      return entry === undefined ? null : outcomeOf(entry);
    },

    list(): readonly IndexEntry[] {
      return readIndex().entries;
    },

    materialize(runId: string, attemptId: string, destination: string): MaterializedCandidate {
      const entry = readIndex().entries.find(item => item.runId === runId && item.attemptId === attemptId);
      if (entry === undefined) throw new Error(`未找到已冻结的 attempt：${runId}/${attemptId}`);
      const source = join(attemptDirectory(entry.taskId, runId, attemptId), 'candidate');
      if (!existsSync(source)) throw new FrozenSnapshotTamperedError(`冻结快照缺失：${relativePathOf(source)}`);
      const digest = digestTree(source, { excluded });
      if (digest.treeHash !== entry.treeHash) {
        throw new FrozenSnapshotTamperedError(`冻结快照摘要与冻结记录不一致：记录 ${entry.treeHash}，当前 ${digest.treeHash}`);
      }
      const target = resolve(destination);
      if (existsSync(target) && readdirSync(target).length > 0) throw new Error(`物化目标必须为空：${target}`);
      copyTree(source, target, excludedSet);
      return { directory: target, treeHash: digest.treeHash, fileCount: digest.fileCount };
    },
  };
}
