/**
 * 自动测评的受控启动层。
 *
 * 核心原则：API 不直接持有实验子进程。
 *
 *   API --spawn(detached)--> supervisor --spawn--> dsh-compare 子进程
 *
 * 本模块负责：
 * - 启动记录持久化（原子写 .tmp + rename），目录可注入，默认 <仓库根>/data/launches；
 * - 启动：校验 -> 计算计划作答次数 -> 冻结配置快照 -> spawn detached supervisor；
 * - 进程归属判定：绝不只看 pid，必须同时校验 pidStartedAt（取不到启动时间时如实降级为「无法确认归属」）；
 * - 纯函数 mergeState：唯一决定展示语义的地方（进程判定与清理判定永不互相冒充）；
 * - 对账 sweeper：读 exit.json 落定 exited/cancelled，租约过期判 unknown，取消标记 + 进程判定消失判 aborted；
 * - 取消：先写取消标记由 supervisor 代理执行；supervisor 已死时只终止能证明归属的存活进程，并如实报告残留三态。
 *
 * GET /api/experiments 只调用 list()/describe()，它们不写任何文件。
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { moveToTrash, trashDirectoryName } from './cleanup.ts';
import { join, resolve } from 'node:path';
import { tasks } from '@fsa/catalog';
import { validateComparison, type DshComparisonOptions } from '../../../packages/evaluation/src/dsh-comparison.ts';
import {
  childrenOf, defaultHeartbeatMs, defaultLeaseTtlMs, descendantsGone, isAlive, probeOwnership,
  readJsonObject, terminateTree, updateRecord, writeJsonAtomic, type ExitFact, type Ownership,
} from '../../../scripts/experiment-supervisor.ts';
import { apiRepositoryRoot, type ConfigProvider } from './config.ts';

/** 启动标识与实验目录名共用一套形状。 */
export const launchIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** 取消后轮询确认退出的时长。 */
export const terminationConfirmMs = 10_000;
/** 启动后等待 supervisor 完成自登记握手的时长；超时不代表失败，只是尚未登记。 */
export const registrationWaitMs = 5_000;

export type RecordState = 'starting' | 'registered' | 'running' | 'exited' | 'cancelled' | 'aborted' | 'unknown';
export type ExperimentState = 'running' | 'completed' | 'cancelled' | 'failed' | null;
export type CleanupState = 'pending' | 'complete' | 'retained' | null;
export type LaunchKind = 'comparison' | 'check';

/* ================================================================== *
 * 状态归并：三个独立事实，永不互相冒充
 * ================================================================== */

export interface MergedState {
  /** 进程判定。aborted 属于进程判定，永远不与 cleanup 合并。 */
  process: 'live' | 'exited' | 'cancelled' | 'aborted' | 'unknown';
  /** 展示结论。 */
  verdict: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'aborted' | 'unknown';
  text: string;
  /** 清理判定，独立于进程判定。 */
  cleanup: 'complete' | 'retained' | 'unknown';
  cleanupText: string;
  /** 清理只能说到「未知，可能残留」时为 true。 */
  cleanupUncertain: boolean;
  /** 退出码是否代表成功；没有退出事实时为 null。 */
  exitOk: boolean | null;
}

/** 取消类信号：出现它们时结论是「取消」而不是「失败」。 */
const cancellationSignals = new Set(['cancel-requested', 'SIGINT', 'SIGTERM', 'SIGKILL', 'SIGBREAK']);

/** 取消事实的判定只有这一个地方：显式的 cancelled 标记，或取消类信号。 */
export function isCancellation(recordState: RecordState, exitFact: ExitFact | null): boolean {
  if (recordState === 'cancelled') return true;
  if (exitFact === null) return false;
  if (exitFact.cancelled === true) return true;
  return exitFact.signal !== null && cancellationSignals.has(exitFact.signal);
}

function cleanupVerdict(cleanupState: CleanupState): Pick<MergedState, 'cleanup' | 'cleanupText' | 'cleanupUncertain'> {
  // 只有 experiment.json 明写 complete 才算已清理，明写 retained 才算已确认保留。
  if (cleanupState === 'complete') return { cleanup: 'complete', cleanupText: '已清理（experiment.json 明写 complete）', cleanupUncertain: false };
  if (cleanupState === 'retained') return { cleanup: 'retained', cleanupText: '已确认保留临时目录（experiment.json 明写 retained）', cleanupUncertain: false };
  // pending 或没有登记：子进程被强杀时不会自己写 retained（写者已死），只能说到「未知，可能残留」。
  return { cleanup: 'unknown', cleanupText: cleanupState === 'pending' ? '清理未知，可能残留（experiment.json 仍为 pending）' : '清理未知，可能残留（没有 experiment.json 清理记录）', cleanupUncertain: true };
}

/**
 * 唯一决定展示语义的纯函数。四个事实各自独立：
 * - experimentState 由 dsh-compare 子进程写入 experiment.json（running/completed/cancelled/failed）；
 * - recordState 是启动记录的进程判定（starting/registered/running/exited/cancelled/aborted/unknown）；
 * - exitFact 是 supervisor 写下的退出事实（code/signal/at/descendantsVerified）；
 * - cleanupState 是 dsh-compare 子进程写下的清理真相（pending/complete/retained）。
 *
 * 真值表要点：
 * - 有 exit.json：按退出码落定 completed（码 0 且 experiment completed 或不存在）或 failed；取消类信号落定为 cancelled。
 * - 无 exit.json：跟随启动记录的进程判定，unknown 就是 unknown，绝不推断成 launch-failed。
 * - 清理只认 experiment.json 的明写值；pending 或不登记一律「未知，可能残留」。
 * - 码 0 且没有 experiment.json 的情况（仅预检）如实说成「没有实验记录」，不谎报失败。
 */
export function mergeState(experimentState: ExperimentState, recordState: RecordState, exitFact: ExitFact | null, cleanupState: CleanupState): MergedState {
  const cleanup = cleanupVerdict(cleanupState);
  const cancelled = isCancellation(recordState, exitFact);
  if (exitFact !== null) {
    const succeeded = exitFact.code === 0 && (experimentState === 'completed' || experimentState === null);
    if (!succeeded && cancelled) {
      return { process: 'cancelled', verdict: 'cancelled', text: '已取消：进程已退出且终止事实已落盘。', ...cleanup, exitOk: false };
    }
    if (succeeded) {
      return experimentState === 'completed'
        ? { process: 'exited', verdict: 'completed', text: '已完成：进程退出码 0，experiment.json 记录 completed。', ...cleanup, exitOk: true }
        : { process: 'exited', verdict: 'completed', text: '进程退出码 0；该实验没有 experiment.json（仅预检，或报告未落盘）。', ...cleanup, exitOk: true };
    }
    return experimentState === 'cancelled'
      ? { process: 'cancelled', verdict: 'cancelled', text: '已取消：experiment.json 记录 cancelled。', ...cleanup, exitOk: false }
      : { process: 'exited', verdict: 'failed', text: '失败：进程退出码 ' + String(exitFact.code) + '，experiment.json 为 ' + String(experimentState ?? '未登记') + '。', ...cleanup, exitOk: false };
  }
  if (recordState === 'aborted') return { process: 'aborted', verdict: 'aborted', text: '已中止：进程判定为已消失，但没有退出事实；不声称已确认终止。', ...cleanup, exitOk: null };
  if (recordState === 'cancelled') return { process: 'cancelled', verdict: 'cancelled', text: '取消已请求：尚未取得退出事实，执行状态未知。', ...cleanup, exitOk: null };
  if (recordState === 'unknown' || recordState === 'exited') {
    return { process: 'unknown', verdict: 'unknown', text: '执行状态未知，可能仍在运行：没有退出事实，也不推断为启动失败。', ...cleanup, exitOk: null };
  }
  if (recordState === 'starting') return { process: 'live', verdict: 'starting', text: '正在启动：supervisor 尚未完成自登记握手。', ...cleanup, exitOk: null };
  return { process: 'live', verdict: 'running', text: recordState === 'registered' ? 'supervisor 已登记，准备启动作答子进程。' : '运行中。', ...cleanup, exitOk: null };
}

/* ================================================================== *
 * 启动记录
 * ================================================================== */

export interface LaunchPlan {
  readonly taskIds: readonly string[];
  readonly presets: readonly string[];
  readonly modes: readonly string[];
  readonly repeats: number;
  readonly timeoutMinutes: number;
  readonly maxTokens: number;
  readonly measurePerformance: boolean;
  readonly provider: string;
  readonly model: string;
  /** 计划总作答次数 = 题数 × 预设数 × 等级数 × 重复次数。 */
  readonly answers: number;
  /** 同时推进的作答数；1 = 串行。 */
  readonly concurrency: number;
}

export interface DescendantEntry {
  pid: number;
  startedAt: string | null;
  role: string;
}

export interface LaunchRecord {
  launchId: string;
  supervisorToken: string;
  kind: LaunchKind;
  experimentId: string;
  outputRoot: string;
  startedAt: string;
  state: RecordState;
  exitCode: number | null;
  logPath: string;
  plan: LaunchPlan;
  /** 已解析的子进程命令行（脱敏：只有开关与选择，没有环境变量与令牌）。 */
  args: string[];
  /** 子进程脚本与参数由启动记录自描述：supervisor 重启后仍能按同一条记录执行。 */
  childScript: string;
  childArgs: string[];
  exitPath: string;
  cancelPath: string;
  pid: number | null;
  pidStartedAt: string | null;
  childPid: number | null;
  childStartedAt: string | null;
  heartbeatAt: string | null;
  leaseTtlMs: number;
  heartbeatMs: number;
  descendants: DescendantEntry[];
  cancelRequestedAt: string | null;
  settledAt: string | null;
  note: string | null;
  [key: string]: unknown;
}

/* ================================================================== *
 * 视图
 * ================================================================== */

export interface ResidueView {
  /** none 只在能证明归属时给出；扫描无结果默认 unknown。 */
  status: 'none' | 'unknown' | 'present';
  detail: string;
  /** 扫描发现的、能证明归属的存活 pid。 */
  pids: number[];
}

export interface DescendantView {
  pid: number;
  startedAt: string | null;
  role: string;
  ownership: Ownership;
}

export interface LaunchView {
  launchId: string;
  kind: LaunchKind;
  experimentId: string;
  outputRoot: string;
  startedAt: string;
  /** 启动记录里的进程判定原值。 */
  state: RecordState;
  exitCode: number | null;
  logPath: string;
  plan: LaunchPlan;
  args: string[];
  pid: number | null;
  pidStartedAt: string | null;
  ownership: Ownership;
  childPid: number | null;
  childOwnership: Ownership;
  heartbeatAt: string | null;
  leaseExpired: boolean;
  note: string | null;
  /** 记录可读时才为 true；损坏的记录以 readable: false 与原因出现，不静默消失。 */
  readable: boolean;
  error: string | null;
  exit: ExitFact | null;
  merged: MergedState;
  residue: ResidueView;
  descendants: DescendantView[];
  experiment: { directory: string; exists: boolean; state: ExperimentState; cleanup: CleanupState };
  cancelRequested: boolean;
}

export interface CancelOutcome {
  launchId: string;
  /** delegated：交给存活 supervisor；terminated：supervisor 已死，由 API 终止可证归属的进程；unknown：不声称已终止。 */
  action: 'delegated' | 'delegated-unconfirmed' | 'terminated' | 'terminated-unconfirmed' | 'unknown' | 'not-running';
  confirmedExit: boolean;
  text: string;
  residue: ResidueView;
  targets: number[];
}

/* ================================================================== *
 * 参数
 * ================================================================== */

export interface LaunchRequest {
  /** 题目范围：one（试一题 CACHE-02）/ all / core / difficulty / manual。 */
  scope?: string;
  taskIds?: readonly string[];
  difficulty?: string;
  presets?: readonly string[];
  modes?: readonly string[];
  repeats?: number;
  timeoutMinutes?: number;
  maxTokens?: number;
  measurePerformance?: boolean;
  /** 同时推进的作答数（1–8，默认 1）。 */
  concurrency?: number;
  provider?: string;
  model?: string;
  /** 仅预检：传 --check，不启动 DSH、不调用模型。 */
  check?: boolean;
  /** 报告根覆盖；缺省用冻结快照的 BENCH_DSH_REPORT_DIR。 */
  outputRoot?: string;
  /**
   * 续跑既有实验：给出实验标识时，子进程用 `--resume <id>` 只补跑未完成/待定的行，
   * 已落定的作答与分数原样保留。用于「跑完大部分、少数未作答或出错」的场景。
   * 与新建互斥：给出该项时不再新建报告目录。
   */
  resumeExperimentId?: string;
}

export interface LaunchesOptions {
  config: ConfigProvider;
  /** 启动记录目录；测试注入临时目录。缺省 <仓库根>/data/launches。 */
  launchesRoot?: string;
  /** 仓库根；决定子进程脚本路径与相对目录。 */
  repositoryRoot?: string;
  /** 继承环境（测试注入）；缺省 process.env。 */
  env?: NodeJS.ProcessEnv;
  /** supervisor 脚本路径；测试注入假脚本。 */
  supervisorScript?: string;
  /** 作答子进程脚本路径；测试注入假脚本。 */
  childScript?: string;
  /** supervisor 的 node 前置参数；默认 ['--import','tsx']，测试注入假脚本时可设为 []。 */
  supervisorPrefix?: readonly string[];
  leaseTtlMs?: number;
  heartbeatMs?: number;
  /** 轮询等待的步进间隔（注册与取消确认共用）；测试可缩短。 */
  pollMs?: number;
  /** 取消后等待退出事实的时长；测试可缩短。 */
  confirmMs?: number;
  /** 启动后等待自登记握手的时长；测试可缩短。 */
  registrationWaitMs?: number;
  now?: () => number;
}

export class LaunchError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = 'LaunchError';
    this.status = status;
  }
}

/* ================================================================== *
 * 纯读辅助
 * ================================================================== */

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function textArrayOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function readExitFact(path: string): ExitFact | null {
  const raw = readJsonObject(path);
  if (raw === null) return null;
  const at = textOf(raw.at);
  if (at === null) return null;
  return {
    code: numberOrNull(raw.code),
    signal: typeof raw.signal === 'string' ? raw.signal : null,
    at,
    descendantsVerified: raw.descendantsVerified === true,
    note: typeof raw.note === 'string' ? raw.note : null,
    cancelled: raw.cancelled === true,
  };
}

/** 读 experiment.json 的两个事实：状态与清理真相。只读，不写。 */
function readExperimentFacts(directory: string): { exists: boolean; state: ExperimentState; cleanup: CleanupState } {
  const path = join(directory, 'experiment.json');
  if (!existsSync(path)) return { exists: false, state: null, cleanup: null };
  const raw = readJsonObject(path);
  if (raw === null) return { exists: true, state: null, cleanup: null };
  const cleanupRaw = raw.cleanup;
  const cleanupState = typeof cleanupRaw === 'object' && cleanupRaw !== null && !Array.isArray(cleanupRaw) ? (cleanupRaw as Record<string, unknown>).state : null;
  return {
    exists: true,
    state: raw.state === 'running' || raw.state === 'completed' || raw.state === 'cancelled' || raw.state === 'failed' ? raw.state : null,
    cleanup: cleanupState === 'pending' || cleanupState === 'complete' || cleanupState === 'retained' ? cleanupState : null,
  };
}

/**
 * supervisor 是否存活。两条互相独立的证据，任一成立即可，但都要求 pid 真的存在：
 * - 进程启动时间与登记一致（最严格的一手证据）；
 * - 平台取不到启动时间时（如实降级为 unconfirmed），退一步用「pid 存活 + 租约仍新」——
 *   心跳只有持有该令牌的 supervisor 会刷新，因此租约新说明登记的那个 supervisor 仍在跑。
 * 两条都不成立时返回 false，绝不假装确认。
 */
function supervisorRunning(record: LaunchRecord, ttl: number, now: () => number): boolean {
  const pid = numberOrNull(record.pid);
  if (pid === null || !isAlive(pid)) return false;
  const ownership = probeOwnership(pid, textOf(record.pidStartedAt));
  if (ownership === 'alive') return true;
  if (ownership === 'dead') return false;
  const heartbeatAt = textOf(record.heartbeatAt);
  if (heartbeatAt === null) return false;
  const age = now() - Date.parse(heartbeatAt);
  return Number.isFinite(age) && age <= ttl;
}

/** POSIX 下判断进程组是否仍存在；非 POSIX 恒为 false。 */
function groupAlive(pgid: number): boolean {
  if (process.platform === 'win32') return false;
  try { process.kill(-pgid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** 子进程列表（含一层后代）：只在能证明归属时推进，任何不确定都返回 null。 */
function liveAttributable(pid: number | null, startedAt: string | null): { alive: boolean; certain: boolean } {
  if (pid === null) return { alive: false, certain: true };
  if (!isAlive(pid)) return { alive: false, certain: true };
  const ownership = probeOwnership(pid, startedAt);
  if (ownership === 'alive') return { alive: true, certain: true };
  return { alive: true, certain: false };
}

/**
 * 残留扫描三态。默认口径是「残留未知」：扫描无结果不等于无残留，
 * 主动脱离进程组的后代本来就扫不到，归属无法证明时更不能声称干净。
 */
function scanResidue(record: LaunchRecord, childOwnership: Ownership): ResidueView {
  const childPid = numberOrNull(record.childPid);
  const childStartedAt = textOf(record.childStartedAt);
  const entries = Array.isArray(record.descendants) ? record.descendants : [];
  const candidates: Array<{ pid: number; startedAt: string | null; role: string }> = [];
  for (const entry of entries) {
    if (typeof entry?.pid === 'number') candidates.push({ pid: entry.pid, startedAt: typeof entry.startedAt === 'string' ? entry.startedAt : null, role: typeof entry.role === 'string' ? entry.role : 'descendant' });
  }
  if (childPid !== null && !candidates.some(item => item.pid === childPid)) candidates.push({ pid: childPid, startedAt: childStartedAt, role: 'dsh-compare' });
  const live: number[] = [];
  let uncertain = false;
  const seen = new Set<number>();
  for (const candidate of candidates) {
    if (seen.has(candidate.pid)) continue;
    seen.add(candidate.pid);
    const state = liveAttributable(candidate.pid, candidate.startedAt);
    if (!state.alive) continue;
    if (!state.certain) { uncertain = true; continue; }
    live.push(candidate.pid);
    const children = childrenOf(candidate.pid);
    if (children === null) uncertain = true; else for (const child of children) if (!seen.has(child)) live.push(child);
  }
  if (live.length > 0) {
    const unique = [...new Set(live)];
    return { status: 'present', detail: '仍有残留：扫描发现能证明归属的存活进程 ' + unique.join('、') + '。', pids: unique };
  }
  if (uncertain || childOwnership === 'unconfirmed') {
    return { status: 'unknown', detail: '残留未知：存在无法确认归属的存活 pid，或后代扫描不可用。', pids: [] };
  }
  // 记录的 pid 都已不存活。能否说「已确认无残留」取决于归属是否可证。
  const attributable = childPid !== null && childStartedAt !== null && childOwnership === 'dead';
  if (!attributable) return { status: 'unknown', detail: '残留未知：没有可证明归属的存活进程，也没有可核对的后代证据。', pids: [] };
  if (process.platform === 'win32') {
    // Windows 上子进程已退出即意味着 taskkill /t 的父子链不存在，但仍可能有脱离进程组的后代。
    return { status: 'unknown', detail: '残留未知：记录中的进程都已退出，但无法排除已脱离进程组的后代。', pids: [] };
  }
  return groupAlive(childPid) || !descendantsGone(childPid)
    ? { status: 'present', detail: '仍有残留：以独立进程组启动的作答进程组仍存在。', pids: [childPid] }
    : { status: 'none', detail: '已确认无残留：以独立进程组启动的作答进程组已退出，归属可证。', pids: [] };
}

/* ================================================================== *
 * 主体
 * ================================================================== */

export interface Launches {
  readonly root: string;
  /** 纯读：列出全部启动记录与归并视图；不写任何文件。 */
  list(): LaunchView[];
  /** 纯读：单条启动记录。 */
  describe(launchId: string): LaunchView;
  planOf(request: LaunchRequest): LaunchPlan;
  launch(request: LaunchRequest): Promise<LaunchView>;
  cancel(launchId: string): Promise<CancelOutcome>;
  /**
   * 把一条启动记录（账本 json、exit.json、日志与取消标记）移进回收目录。
   * 进程仍在运行时拒绝：账本是对账所依赖的事实来源，移走它会让 sweeper 失去依据。
   */
  clean(launchId: string): { trashPath: string; moved: string[] };
  /** 对账并原子写回；由进程内定时器调用，GET 路由绝不调用它。 */
  sweep(): void;
  close(): void;
}

export function defaultLaunchesRoot(repositoryRoot: string = apiRepositoryRoot): string {
  return join(repositoryRoot, 'data', 'launches');
}

function resolveScopeTaskIds(request: LaunchRequest): string[] {
  const scope = request.scope ?? 'one';
  const selectable = tasks.filter(task => task.status !== 'designed');
  if (scope === 'one') return ['CACHE-02'];
  if (scope === 'all') return selectable.map(task => task.id);
  if (scope === 'core') return selectable.filter(task => task.track === 'core').map(task => task.id);
  if (scope === 'difficulty') {
    if (request.difficulty === undefined || request.difficulty === '') throw new LaunchError(400, '按难度选择时必须给出 difficulty。');
    const chosen = selectable.filter(task => task.difficulty === request.difficulty);
    if (chosen.length === 0) throw new LaunchError(400, '该难度下没有已具备题目包的题。');
    return chosen.map(task => task.id);
  }
  if (scope === 'manual') {
    if (!Array.isArray(request.taskIds) || request.taskIds.length === 0) throw new LaunchError(400, '手工多选至少要选一道题。');
    return [...request.taskIds];
  }
  throw new LaunchError(400, '未知的题目范围：' + scope + '。');
}

export function createLaunches(options: LaunchesOptions): Launches {
  const repositoryRoot = options.repositoryRoot ?? apiRepositoryRoot;
  const root = resolve(options.launchesRoot ?? defaultLaunchesRoot(repositoryRoot));
  const env = options.env ?? process.env;
  const now = options.now ?? (() => Date.now());
  const leaseTtlMs = options.leaseTtlMs ?? defaultLeaseTtlMs;
  const heartbeatMs = options.heartbeatMs ?? defaultHeartbeatMs;
  const pollMs = options.pollMs ?? 100;
  const confirmMs = options.confirmMs ?? terminationConfirmMs;
  const registrationWaitMs = options.registrationWaitMs ?? 5_000;
  const supervisorScript = resolve(options.supervisorScript ?? join(repositoryRoot, 'scripts', 'experiment-supervisor.ts'));
  const childScript = resolve(options.childScript ?? join(repositoryRoot, 'scripts', 'dsh-compare.ts'));
  const supervisorPrefix = [...(options.supervisorPrefix ?? ['--import', 'tsx'])];
  const timers = new Set<NodeJS.Timeout>();

  const recordPath = (launchId: string): string => join(root, launchId + '.json');
  const exitPathOf = (launchId: string): string => join(root, launchId + '.exit.json');
  const cancelPathOf = (launchId: string): string => join(root, launchId + '.cancel-requested');

  const readRecord = (launchId: string): LaunchRecord | null => {
    if (!launchIdPattern.test(launchId)) return null;
    const raw = readJsonObject(recordPath(launchId));
    return raw === null ? null : raw as unknown as LaunchRecord;
  };

  const delay = (ms: number): Promise<void> => new Promise(resolvePromise => {
    const timer = setTimeout(() => { timers.delete(timer); resolvePromise(); }, ms);
    timers.add(timer);
  });

  /* ------------------------------ 参数与计划 ------------------------------ */

  /** 冻结快照 -> 子进程命令行。所有选择都写进 argv 数组，绝不拼命令字符串。 */
  function childArguments(plan: LaunchPlan, experimentId: string, outputRoot: string, check: boolean, resume = false): string[] {
    // 续跑用 --resume <既有实验标识>；新建用 --experiment-id <新标识>。两者互斥。
    const argv = [resume ? '--resume' : '--experiment-id', experimentId, '--output', outputRoot, '--provider', plan.provider, '--model', plan.model,
      '--presets', plan.presets.join(','), '--modes', plan.modes.join(','),
      '--tasks', plan.taskIds.join(','), '--repeat', String(plan.repeats),
      '--minutes', String(plan.timeoutMinutes), '--max-tokens', String(plan.maxTokens)];
    if (!plan.measurePerformance) argv.push('--no-measure');
    // 只在真的并行时下发，避免串行运行的命令行与既有记录产生无意义差异。
    if (plan.concurrency > 1) argv.push('--concurrency', String(plan.concurrency));
    if (check) argv.push('--check');
    return argv;
  }

  function outputRootOf(request: LaunchRequest): string {
    const snapshot = options.config.snapshot();
    return resolve(request.outputRoot ?? snapshot.BENCH_DSH_REPORT_DIR ?? join(repositoryRoot, 'data', 'experiments'));
  }

  /**
   * 续跑既有实验时，配置以**报告里的 settings** 为准，而不是界面缺省值。
   *
   * 为什么必须这样：`--resume` 会核对本次配置与既有报告是否一致，不一致直接拒绝。
   * 而报告中心的续跑按钮只发实验标识——用户不需要、也不该重新选择题目与等级，
   * 续跑的语义是「照原样继续」。若 plan 仍按界面缺省值构造（默认题目范围、配置里的
   * 预设与等级），与报告里的 55 题/ptc/high 必然不符，续跑会被自己拒绝。
   */
  function planFromExistingReport(outputRoot: string, experimentId: string): LaunchPlan | null {
    const path = join(outputRoot, experimentId, 'experiment.json');
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { settings?: Record<string, unknown> };
      const settings = parsed.settings;
      if (settings === undefined || typeof settings !== 'object' || settings === null) return null;
      const arrayOf = (value: unknown): string[] => Array.isArray(value) && value.every(item => typeof item === 'string') ? value as string[] : [];
      const numberOf = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
      const taskIds = arrayOf(settings.taskIds);
      const presets = arrayOf(settings.presets);
      const modes = arrayOf(settings.modes);
      if (taskIds.length === 0 || presets.length === 0 || modes.length === 0) return null;
      const repeats = numberOf(settings.repeats, 1);
      const timeoutMs = numberOf(settings.timeoutMs, 1_200_000);
      return {
        taskIds, presets: presets as LaunchPlan['presets'], modes, repeats,
        timeoutMinutes: Math.max(1, Math.round(timeoutMs / 60_000)),
        maxTokens: numberOf(settings.maxTokens, 16_384),
        measurePerformance: settings.measurePerformance === true,
        provider: typeof settings.provider === 'string' ? settings.provider : '',
        model: typeof settings.model === 'string' ? settings.model : '',
        concurrency: numberOf(settings.concurrency, 1),
        answers: taskIds.length * presets.length * modes.length * repeats,
      };
    } catch { return null; }
  }

  function planOf(request: LaunchRequest): LaunchPlan {
    const snapshot = options.config.snapshot();
    // 续跑：完全沿用既有报告的配置，绝不掺入界面缺省值。
    if ((request.resumeExperimentId ?? '').trim() !== '') {
      // 参数级冲突先判：与标识形状、路径存在性都无关，只取决于请求本身。
      if (request.check === true) throw new LaunchError(400, '续跑不能与预检同时使用：续跑会真实调用模型。');
      const root = outputRootOf(request);
      const id = (request.resumeExperimentId ?? '').trim();
      // 再校验标识形状，最后才谈存在性：`../escape` 这类输入必须报「标识不合法」，
      // 而不是拼出一个越界路径再去检查它是否存在。
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) throw new LaunchError(400, '续跑标识不合法：只接受字母或数字开头、由字母数字下划线和连字符组成的 1–64 字符标识。');
      // planOf 在 launch 之前被调用，所以「目标不存在」要在这里就说清楚，
      // 否则用户看到的会是「settings 无法解析」这种误导性的原因。
      const path = join(root, id, 'experiment.json');
      if (!existsSync(path)) throw new LaunchError(400, '续跑目标不存在或没有 experiment.json：' + path + '。');
      const existing = planFromExistingReport(root, id);
      if (existing === null) throw new LaunchError(400, '续跑需要既有报告里有可用的 settings（题目、预设、等级）；该报告的 settings 无法解析，请改用「发起测评」新建一次。');
      // 不做范围校验：题目与等级都来自已成立的报告，它们当初已通过校验。
      return existing;
    }
    const provider = (request.provider ?? snapshot.BENCH_DSH_PROVIDER ?? '').trim();
    const model = (request.model ?? snapshot.BENCH_DSH_MODEL ?? '').trim();
    // 省略 = 沿用配置默认；显式给出（含空数组）就按 validateComparison 的规则校验，绝不静默补默认值。
    const presets = request.presets === undefined
      ? (snapshot.BENCH_DSH_PRESETS ?? 'standard').split(/[,\s]+/).filter(Boolean)
      : [...request.presets];
    const modes = request.modes === undefined
      ? (snapshot.BENCH_DSH_REASONING_EFFORT ?? 'off,high').split(/[,\s]+/).filter(Boolean)
      : [...request.modes];
    const repeats = request.repeats ?? 1;
    const timeoutMinutes = request.timeoutMinutes ?? 20;
    const maxTokens = request.maxTokens ?? 16384;
    const measurePerformance = request.measurePerformance ?? snapshot.BENCH_MEASURE_PERFORMANCE === '1';
    const taskIds = resolveScopeTaskIds(request);
    const concurrency = request.concurrency ?? 1;
    // 复用 @fsa/evaluation 的 validateComparison：参数规则只有一个家，API 不另写一套。
    const candidate: DshComparisonOptions = {
      dshRoot: resolve(snapshot.BENCH_DSH_ROOT ?? join(repositoryRoot, 'missing-dsh')),
      dshHome: resolve(snapshot.BENCH_DSH_HOME ?? snapshot.DSH_HOME ?? join(repositoryRoot, 'missing-dsh-home')),
      profile: snapshot.BENCH_DSH_PROFILE ?? 'sdk',
      workspacePermission: (snapshot.BENCH_DSH_WORKSPACE_PERMISSION ?? 'workspace-write') as DshComparisonOptions['workspacePermission'],
      provider, model, presets: presets as DshComparisonOptions['presets'], modes, taskIds, repeats, maxTokens,
      timeoutMs: timeoutMinutes * 60_000, outputDirectory: join(outputRootOf(request), 'pending-claim'), image: 'pending', imageDigest: 'pending',
      measurePerformance, concurrency,
    };
    try { validateComparison(candidate); }
    catch (error) { throw new LaunchError(400, error instanceof Error ? error.message : '测评参数无效。'); }
    return { taskIds, presets, modes, repeats, timeoutMinutes, maxTokens, measurePerformance, provider, model, concurrency,
      answers: taskIds.length * presets.length * modes.length * repeats };
  }

  /* ------------------------------ 纯读视图 ------------------------------ */

  const emptyPlan: LaunchPlan = { taskIds: [], presets: [], modes: [], repeats: 0, timeoutMinutes: 0, maxTokens: 0, measurePerformance: false, provider: '', model: '', concurrency: 1, answers: 0 };

  function unreadableView(launchId: string, error: string): LaunchView {
    return { launchId, kind: 'comparison', experimentId: launchId, outputRoot: '', startedAt: '', state: 'unknown', exitCode: null,
      logPath: '', plan: emptyPlan, args: [], pid: null, pidStartedAt: null, ownership: 'unconfirmed', childPid: null, childOwnership: 'unconfirmed',
      heartbeatAt: null, leaseExpired: false, note: null, readable: false, error, exit: null, merged: mergeState(null, 'unknown', null, null),
      residue: { status: 'unknown', detail: '启动记录不可读，残留未知。', pids: [] }, descendants: [],
      experiment: { directory: '', exists: false, state: null, cleanup: null }, cancelRequested: false };
  }

  function viewOf(record: LaunchRecord, launchId: string): LaunchView {
    const pid = numberOrNull(record.pid);
    const childPid = numberOrNull(record.childPid);
    const pidStartedAt = textOf(record.pidStartedAt);
    const childStartedAt = textOf(record.childStartedAt);
    const ownership = probeOwnership(pid, pidStartedAt);
    const childOwnership = probeOwnership(childPid, childStartedAt);
    const exit = readExitFact(textOf(record.exitPath) ?? exitPathOf(launchId));
    const experimentId = textOf(record.experimentId) ?? launchId;
    const outputRoot = textOf(record.outputRoot) ?? '';
    const facts = readExperimentFacts(join(outputRoot === '' ? root : outputRoot, experimentId));
    const heartbeatAt = textOf(record.heartbeatAt);
    const ttl = typeof record.leaseTtlMs === 'number' && Number.isFinite(record.leaseTtlMs) ? record.leaseTtlMs : leaseTtlMs;
    const runningish = record.state === 'running' || record.state === 'registered' || record.state === 'starting';
    const leaseExpired = runningish && (heartbeatAt === null || !(now() - Date.parse(heartbeatAt) <= ttl));
    const merged = mergeState(facts.state, record.state ?? 'unknown', exit, facts.cleanup);
    const descendants: DescendantView[] = (Array.isArray(record.descendants) ? record.descendants : []).map(item => ({
      pid: item.pid, startedAt: item.startedAt ?? null, role: item.role ?? 'descendant',
      ownership: probeOwnership(item.pid, item.startedAt ?? null),
    }));
    return {
      launchId, kind: record.kind === 'check' ? 'check' : 'comparison', experimentId, outputRoot,
      startedAt: textOf(record.startedAt) ?? '', state: record.state ?? 'unknown', exitCode: numberOrNull(record.exitCode),
      logPath: textOf(record.logPath) ?? '', plan: record.plan ?? emptyPlan, args: textArrayOf(record.args),
      pid, pidStartedAt, ownership, childPid, childOwnership, heartbeatAt, leaseExpired,
      note: typeof record.note === 'string' ? record.note : null, readable: true, error: null, exit, merged,
      residue: scanResidue(record, childOwnership), descendants,
      experiment: { directory: join(outputRoot === '' ? root : outputRoot, experimentId), exists: facts.exists, state: facts.state, cleanup: facts.cleanup },
      cancelRequested: existsSync(textOf(record.cancelPath) ?? cancelPathOf(launchId)),
    };
  }

  const listIds = (): string[] => {
    try {
      return readdirSync(root)
        // 回收目录不是启动记录；清理过的账本不得再出现在列表里。
        .filter(name => name !== trashDirectoryName)
        .filter(name => name.endsWith('.json') && !name.endsWith('.exit.json'))
        .map(name => name.slice(0, -5));
    } catch { return []; }
  };

  /* ------------------------------ 对账 ------------------------------ */

  const settled: readonly RecordState[] = ['exited', 'cancelled', 'aborted'];

  function reconcile(launchId: string): void {
    const record = readRecord(launchId);
    if (record === null) return;
    if (settled.includes(record.state)) return;
    // 启动记录仍指向仓库内的真实 supervisor 脚本说明它由本仓库托管；
    // 否则（例如手工写入的旧记录）只做只读判定，绝不改写别人的文件。
    if (textOf(record.childScript) === null) return;
    const exitPath = textOf(record.exitPath) ?? exitPathOf(launchId);
    const cancelPath = textOf(record.cancelPath) ?? cancelPathOf(launchId);
    const exit = readExitFact(exitPath);
    if (exit !== null) {
      const cancelled = existsSync(cancelPath) || isCancellation('running', exit);
      updateRecord(recordPath(launchId), { state: cancelled ? 'cancelled' : 'exited', exitCode: exit.code, settledAt: exit.at, note: exit.note });
      return;
    }
    const pid = numberOrNull(record.pid);
    const heartbeatAt = textOf(record.heartbeatAt);
    if (pid === null && heartbeatAt === null) {
      // supervisor 从未登记：授权屏障要求子进程必须读到 state=running + 匹配令牌 + 有效租约，
      // 因此可以确定「没有失管执行」，而不是「可能仍在跑」。
      updateRecord(recordPath(launchId), { state: 'aborted', settledAt: new Date(now()).toISOString(),
        note: 'supervisor 未完成自登记握手，子进程未通过授权屏障，因此没有执行任何作答。' });
      return;
    }
    const ttl = typeof record.leaseTtlMs === 'number' && Number.isFinite(record.leaseTtlMs) ? record.leaseTtlMs : leaseTtlMs;
    if (heartbeatAt !== null && now() - Date.parse(heartbeatAt) <= ttl) return;
    const ownership = probeOwnership(pid, textOf(record.pidStartedAt));
    if (ownership === 'alive') return;
    const cancelRequested = existsSync(cancelPath);
    const liveChild = isAlive(numberOrNull(record.childPid) ?? 0);
    const nextState: RecordState = cancelRequested && !liveChild ? 'aborted' : 'unknown';
    updateRecord(recordPath(launchId), {
      state: nextState, settledAt: new Date(now()).toISOString(),
      note: nextState === 'unknown'
        ? 'supervisor 租约已过期且没有退出事实：执行状态未知，可能仍在运行。'
        : '取消后未取得退出事实，进程判定已消失；不声称已确认终止。',
    });
  }

  function sweep(): void {
    for (const launchId of listIds()) {
      try { reconcile(launchId); } catch { /* 单条记录对账失败不影响其它记录，也绝不写坏账本 */ }
    }
  }

  /* ------------------------------ 启动 ------------------------------ */

  async function launch(request: LaunchRequest): Promise<LaunchView> {
    const plan = planOf(request);
    const snapshot = options.config.snapshot();
    const outputRoot = outputRootOf(request);
    const check = request.check === true;
    const launchId = (check ? 'check-' : 'exp-') + new Date(now()).toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
    /**
     * 续跑：实验标识是**既有**的那个，launchId 仍是新的。
     * 这样启动记录彼此独立（可分别审计与取消），而报告落在原实验上继续累积。
     * 续跑目标必须已存在且含 experiment.json——不允许把续跑指向不存在的实验
     * （那会静默变成一次没有基础的新建，分数无处可合并）。
     */
    const resumeId = (request.resumeExperimentId ?? '').trim();
    const isResume = resumeId !== '';
    if (isResume && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(resumeId)) throw new LaunchError(400, '续跑标识不合法：只接受字母或数字开头、由字母数字下划线和连字符组成的 1–64 字符标识。');
    if (isResume) {
      if (check) throw new LaunchError(400, '续跑不能与预检同时使用：续跑会真实调用模型。');
      const directory = join(outputRoot, resumeId);
      if (!existsSync(join(directory, 'experiment.json'))) throw new LaunchError(400, '续跑目标不存在或没有 experiment.json：' + directory + '。');
    }
    const experimentId = isResume ? resumeId : launchId;
    const supervisorToken = randomUUID();
    mkdirSync(root, { recursive: true });
    const logPath = join(root, launchId + '.log');
    const exitPath = exitPathOf(launchId);
    const cancelPath = cancelPathOf(launchId);
    const childArgs = childArguments(plan, experimentId, outputRoot, check, isResume);
    const record: LaunchRecord = {
      launchId, supervisorToken, kind: check ? 'check' : 'comparison', experimentId, outputRoot,
      startedAt: new Date(now()).toISOString(), state: 'starting', exitCode: null, logPath, plan,
      // args 是脱敏的展示用命令行：与 childArgs 同形，不含环境变量、令牌与配置快照。
      args: childArgs, childScript, childArgs, exitPath, cancelPath,
      pid: null, pidStartedAt: null, childPid: null, childStartedAt: null, heartbeatAt: null,
      leaseTtlMs, heartbeatMs, descendants: [], cancelRequestedAt: null, settledAt: null, note: null,
    };
    writeJsonAtomic(recordPath(launchId), record);
    // 冻结配置快照作为子进程继承环境：不写进启动记录，避免把密钥落盘。
    const childEnv: NodeJS.ProcessEnv = { ...env, ...snapshot };
    try {
      const child = spawn(process.execPath, [...supervisorPrefix, supervisorScript, '--launch-record', recordPath(launchId)], {
        cwd: repositoryRoot, env: childEnv, detached: true, stdio: 'ignore', windowsHide: true,
      });
      child.unref();
      if (child.pid === undefined) throw new Error('无法取得 supervisor 进程号。');
    } catch (error) {
      // spawn 失败是唯一能确定「没有失管执行」的情形：此时还没有任何子进程。
      const message = error instanceof Error ? error.message : String(error);
      updateRecord(recordPath(launchId), { state: 'aborted', settledAt: new Date(now()).toISOString(), note: 'supervisor 启动失败，未启动任何作答进程：' + message });
      throw new LaunchError(400, 'supervisor 启动失败，未启动任何作答进程：' + message);
    }
    // 等待自登记握手，让调用方立刻看到真实状态；超时不代表失败。
    const deadline = now() + registrationWaitMs;
    while (now() < deadline) {
      const current = readRecord(launchId);
      if (current !== null && current.state !== 'starting') break;
      await delay(pollMs);
    }
    const current = readRecord(launchId);
    return current === null ? unreadableView(launchId, '启动记录写入后不可读。') : viewOf(current, launchId);
  }

  /* ------------------------------ 取消 ------------------------------ */

  async function cancel(launchId: string): Promise<CancelOutcome> {
    const record = readRecord(launchId);
    if (record === null) throw new LaunchError(404, launchIdPattern.test(launchId) ? '未找到该启动记录：' + launchId + '。' : '启动标识不合法。');
    const cancelPath = textOf(record.cancelPath) ?? cancelPathOf(launchId);
    const exitPath = textOf(record.exitPath) ?? exitPathOf(launchId);
    // 1. 写取消标记。supervisor 存活时由它执行终止（它是父进程，能找到整棵树）。
    writeJsonAtomic(cancelPath, { requestedAt: new Date(now()).toISOString() });
    updateRecord(recordPath(launchId), { cancelRequestedAt: new Date(now()).toISOString(), cancelRequestedBy: 'api' });
    const supervisorOwnership = probeOwnership(numberOrNull(record.pid), textOf(record.pidStartedAt));
    const supervisorAlive = supervisorRunning(record, typeof record.leaseTtlMs === 'number' && Number.isFinite(record.leaseTtlMs) ? record.leaseTtlMs : leaseTtlMs, now);
    if (supervisorAlive) {
      const confirmed = await waitForExit(exitPath, confirmMs);
      let current = readRecord(launchId) ?? record;
      if (confirmed && !settled.includes(current.state)) {
        // 退出事实已落盘：把进程判定写实为 cancelled（清理判定仍由 experiment.json 单独决定）。
        const fact = readExitFact(exitPath);
        current = (updateRecord(recordPath(launchId), { state: 'cancelled', exitCode: fact?.code ?? null, settledAt: fact?.at ?? new Date(now()).toISOString(), note: fact?.note ?? null }) ?? current) as unknown as LaunchRecord;
      }
      return {
        launchId, action: confirmed ? 'delegated' : 'delegated-unconfirmed', confirmedExit: confirmed,
        text: confirmed ? '取消已由 supervisor 代理执行，退出事实已落盘。' : '已请求取消，但未在等待时限内取得退出事实；不声称已终止。',
        residue: scanResidue(current, probeOwnership(numberOrNull(current.childPid), textOf(current.childStartedAt))), targets: [],
      };
    }
    // 2. supervisor 已死或无法确认归属：只终止能证明归属的存活进程树。
    const childPid = numberOrNull(record.childPid);
    const childStartedAt = textOf(record.childStartedAt);
    const candidates: number[] = [];
    if (childPid !== null) candidates.push(childPid);
    for (const entry of Array.isArray(record.descendants) ? record.descendants : []) if (typeof entry?.pid === 'number') candidates.push(entry.pid);
    const targets: number[] = [];
    for (const pid of [...new Set(candidates)]) {
      const startedAt = pid === childPid ? childStartedAt : (record.descendants.find(item => item.pid === pid)?.startedAt ?? null);
      if (isAlive(pid) && probeOwnership(pid, startedAt) === 'alive') targets.push(pid);
    }
    if (targets.length === 0) {
      const residue = scanResidue(record, probeOwnership(childPid, childStartedAt));
      if (!supervisorAlive && (supervisorOwnership === 'unconfirmed' || residue.status === 'unknown')) {
        // 归属无法证明：不改写进程判定，让租约到期后的 sweeper 如实落定 unknown。
        return { launchId, action: 'unknown', confirmedExit: false,
          text: 'supervisor 已不在，也没有可证明归属的存活进程；残留未知，不声称已终止。若仍观察到进程，请手工确认。', residue, targets: [] };
      }
      if (existsSync(exitPath)) {
        const fact = readExitFact(exitPath);
        updateRecord(recordPath(launchId), { state: 'cancelled', exitCode: fact?.code ?? null, settledAt: fact?.at ?? new Date(now()).toISOString(), note: fact?.note ?? null });
        return { launchId, action: 'not-running', confirmedExit: true, text: '没有需要终止的进程：退出事实已存在。', residue, targets: [] };
      }
      // supervisor 与子进程都已确认消失，但没有任何退出事实：按进程判定落定 aborted（不是失败，也不是已完成）。
      updateRecord(recordPath(launchId), { state: 'aborted', settledAt: new Date(now()).toISOString(),
        note: '取消时 supervisor 已不在，也没有可证明归属的存活进程；没有退出事实，因此不声称已确认终止。' });
      return { launchId, action: 'not-running', confirmedExit: false,
        text: '没有发现可证明归属的存活进程；也没有退出事实，因此不声称已完成终止。', residue, targets: [] };
    }
    for (const pid of targets) terminateTree(pid, { force: true });
    const gone = await waitForTargetsGone(targets, confirmMs);
    const current = readRecord(launchId) ?? record;
    const childOwnership = probeOwnership(numberOrNull(current.childPid), textOf(current.childStartedAt));
    const residue = scanResidue(current, childOwnership);
    const terminated = gone && residue.status !== 'present';
    if (terminated) {
      updateRecord(recordPath(launchId), { state: 'aborted', settledAt: new Date(now()).toISOString(),
        note: '取消时 supervisor 已不在；API 终止了可证明归属的进程树（' + targets.join('、') + '）并已轮询确认退出；没有退出事实。' });
    }
    return {
      launchId, action: terminated ? 'terminated' : 'terminated-unconfirmed', confirmedExit: gone,
      text: terminated ? '已终止可证明归属的进程树，并已轮询确认退出。' : '已发出终止但未确认全部退出；不声称已终止。',
      residue, targets,
    };
  }

  async function waitForExit(path: string, timeoutMs: number): Promise<boolean> {
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      if (existsSync(path)) return true;
      await delay(pollMs);
    }
    return existsSync(path);
  }

  async function waitForTargetsGone(targets: readonly number[], timeoutMs: number): Promise<boolean> {
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      if (targets.every(pid => !isAlive(pid))) return true;
      await delay(pollMs);
    }
    return targets.every(pid => !isAlive(pid));
  }

  return {
    root,
    // 纯读：只读文件、prune 过期临时文件也不做（GET 前后账本字节必须不变）。
    list: () => {
      const views: LaunchView[] = [];
      for (const launchId of listIds().sort().reverse()) {
        const record = readRecord(launchId);
        views.push(record === null ? unreadableView(launchId, '启动记录不可读。') : viewOf(record, launchId));
      }
      return views;
    },
    describe: (launchId: string) => {
      const record = readRecord(launchId);
      if (record === null) throw new LaunchError(404, launchIdPattern.test(launchId) ? '未找到该启动记录：' + launchId + '。' : '启动标识不合法。');
      return viewOf(record, launchId);
    },
    planOf,
    launch,
    cancel,
    clean: (launchId: string) => {
      if (!launchIdPattern.test(launchId)) throw new LaunchError(400, '启动标识不合法。');
      const record = readRecord(launchId);
      if (record === null) throw new LaunchError(404, '未找到该启动记录：' + launchId + '。');
      // 只有已落定的记录才可清：运行中的账本是 sweeper 对账的依据，移走它会让进程失管。
      const state = textOf(record.state);
      if (!settled.includes(state as RecordState)) {
        throw new LaunchError(409, '该测评仍在进行或状态未知，请先取消并等待落定，再清理记录。');
      }
      // 一次测评涉及四个同级文件；全部移走，否则列表里会留下孤立的 exit.json 或取消标记。
      const targets = [launchId + '.json', launchId + '.exit.json', launchId + '.log']
        .filter(name => existsSync(join(root, name)));
      const requested = join(root, launchId + '.cancel-requested');
      if (existsSync(requested)) targets.push(launchId + '.cancel-requested');
      return moveToTrash({ root, paths: targets, reason: '启动记录清理' });
    },
    sweep,
    close: () => { for (const timer of timers) clearTimeout(timer); timers.clear(); },
  };
}

/* ================================================================== *
 * 提交根候选（「提交外部作答」表单用）
 * ================================================================== */

export interface SubmissionCandidate {
  name: string;
  directory: string;
  files: number;
  modifiedAt: string;
}

const maximumCandidates = 200;

/** 列出提交根下一层的候选子目录；只读、有界，符号链接/junction 一律跳过。 */
export function listSubmissionCandidates(root: string | null): { root: string | null; candidates: SubmissionCandidate[]; truncated: boolean; warning: string | null } {
  if (root === null || root.trim() === '') return { root: null, candidates: [], truncated: false, warning: '未配置 BENCH_SUBMISSIONS_DIR，提交入口保持关闭。' };
  const resolved = resolve(root);
  let names: string[];
  try { names = readdirSync(resolved); }
  catch (error) { return { root: resolved, candidates: [], truncated: false, warning: '提交根不可读：' + (error instanceof Error ? error.message : String(error)) }; }
  const candidates: SubmissionCandidate[] = [];
  let truncated = false;
  for (const name of names) {
    if (candidates.length >= maximumCandidates) { truncated = true; break; }
    const directory = join(resolved, name);
    try {
      // lstat 不跟随链接：指向提交根之外的 junction/符号链接在这里就被跳过。
      const stat = lstatSync(directory);
      if (!stat.isDirectory()) continue;
      // 有界枚举：只数一层条目，避免遍历大型候选目录。
      candidates.push({ name, directory, files: readdirSync(directory).length, modifiedAt: new Date(stat.mtimeMs).toISOString() });
    } catch { /* 单个目录读不了就跳过，不影响其余候选 */ }
  }
  return { root: resolved, candidates, truncated, warning: null };
}
