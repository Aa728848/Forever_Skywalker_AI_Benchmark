import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { availableParallelism, arch, platform, totalmem } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { scoreExecution, type QualityEvidence } from '@fsa/core';
import { analyzeWorkspace, type StaticPolicy, type StaticReport } from '@fsa/static';
import {
  executionResultValidator, executionScoreValidator, explainExecutionResult, reviewVerdictValidator, runStatusValidator,
  type ExecutionArtifact, type ExecutionCheck, type ExecutionClassification,
  type ExecutionManifest, type ExecutionResult, type ExecutionScore, type ReviewVerdict, type RunStatus, type TaskManifest,
} from '@fsa/contracts';
import { appendRunEvent, digestTree, type RunStore, type SubmissionOutcome } from '@fsa/runs';
import { controlledTestCommand, installHiddenChecks, installPublicChecks, parseTap, taskPackageDir, type CheckOutcome } from '@fsa/tasks';
import {
  InfrastructureUnavailableError, buildContainerArgv, buildContainerInvocation, captureCommand,
  defaultPidsLimit, hiddenChecksMount, isContainerRuntimeFailure, probeContainerRuntime, requirePinnedImage,
  type ContainerRuntime,
} from './container.ts';

export { InfrastructureUnavailableError, probeContainerRuntime, requirePinnedImage } from './container.ts';

/**
 * 最小独立执行器：只从冻结快照物化被测对象，只运行平台白名单里的固定命令，
 * 自己解析检查结果与资源原始数据，并把基础设施故障与被测失败分开。
 * 本机 profile=local 时没有容器隔离，也不阻断网络，结果必须按此口径解读。
 */
const samplerUrl = new URL('./resource-sampler.mjs', import.meta.url).href;
const samplerHostPath = fileURLToPath(new URL('./resource-sampler.mjs', import.meta.url));
export const maximumPhaseOutputBytes = 8 * 1024 * 1024;
/** 仓库根目录：受信侧的 graders/ 隐藏资产从仓库读取，绝不从候选工作区读取。 */
const repositoryRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));

export interface PhaseResource {
  peakRssBytes: number | null;
  userCpuMs: number | null;
  systemCpuMs: number | null;
  sampler: string;
}

/** 自定义传输：容器档案用 docker 调用替换本地的直接命令。 */
export interface PhaseTransport {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  reportHostPath: string;
  stop?: () => void;
  finish?: (exitCode: number | null) => { oomKilled: boolean; error: string | null };
}

export interface PhaseExecution {
  kind: 'public' | 'hidden';
  isolation: 'none' | 'container';
  declaredCommand: string[];
  argv: string[];
  cwd: string;
  timeoutMs: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  spawnError: string | null;
  oomKilled?: boolean;
  outputLimitExceeded?: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutPath: string;
  stderrPath: string;
  reportPath: string;
  resource: PhaseResource;
  outcomes: CheckOutcome[];
}

export interface RunPhaseOptions {
  kind: 'public' | 'hidden';
  declaredCommand: readonly string[];
  workspace: string;
  artifactDir: string;
  timeoutMs: number;
  memoryMb: number;
  signal?: AbortSignal;
  transport?: PhaseTransport;
}

/** 只透传运行必需的变量：代理与凭据不进入被测进程。 */
function childEnvironment(reportPath: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    FSA_RESOURCE_REPORT: reportPath,
  };
  for (const key of ['SystemRoot', 'windir', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'NUMBER_OF_PROCESSORS']) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

/** 命令必须来自平台白名单；node 命令追加堆上限与受信采样器，其余命令按声明原样执行。 */
function buildArgv(declared: readonly string[], memoryMb: number): string[] {
  const [executable = '', ...rest] = controlledTestCommand(declared);
  if (executable !== 'node') return [...declared];
  return [process.execPath, `--import=${samplerUrl}`, `--max-old-space-size=${memoryMb}`, ...rest];
}

function terminateTree(pid: number): void {
  if (platform() === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 进程已退出。
    }
  }
}

function readResourceReport(path: string): PhaseResource {
  if (!existsSync(path)) return { peakRssBytes: null, userCpuMs: null, systemCpuMs: null, sampler: 'unavailable' };
  try {
    const input = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const number = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
    return {
      peakRssBytes: number(input.peakRssBytes),
      userCpuMs: number(input.userCpuMs),
      systemCpuMs: number(input.systemCpuMs),
      sampler: 'node-resource-usage',
    };
  } catch {
    return { peakRssBytes: null, userCpuMs: null, systemCpuMs: null, sampler: 'unreadable' };
  }
}

/** 运行一个检查阶段：超时与取消都会回收整棵进程树。 */
export async function runPhase(options: RunPhaseOptions): Promise<PhaseExecution> {
  mkdirSync(options.artifactDir, { recursive: true });
  const stdoutPath = join(options.artifactDir, `${options.kind}.stdout.tap`);
  const stderrPath = join(options.artifactDir, `${options.kind}.stderr.txt`);
  const reportPath = options.transport?.reportHostPath ?? join(options.artifactDir, `${options.kind}.resources.json`);
  rmSync(reportPath, { force: true });

  const argv = options.transport?.argv ?? buildArgv(options.declaredCommand, options.memoryMb);
  const cwd = options.transport?.cwd ?? options.workspace;
  const environment = options.transport?.env ?? childEnvironment(reportPath);
  const stdoutFd = openSync(stdoutPath, 'w');
  const stderrFd = openSync(stderrPath, 'w');
  const startedAt = process.hrtime.bigint();
  let timedOut = false;
  let cancelled = false;
  let outputLimitExceeded = false;
  let spawnError: string | null = null;

  let child;
  try {
    child = spawn(argv[0] ?? '', argv.slice(1), {
      cwd,
      env: environment,
      stdio: ['ignore', stdoutFd, stderrFd],
      windowsHide: true,
      detached: platform() !== 'win32',
    });
  } catch (error) {
    closeSync(stdoutFd);
    closeSync(stderrFd);
    throw new InfrastructureUnavailableError(error instanceof Error ? error.message : String(error));
  }

  const stop = (reason: 'timeout' | 'cancel' | 'output'): void => {
    if (timedOut || cancelled || outputLimitExceeded) return;
    if (reason === 'timeout') timedOut = true;
    else if (reason === 'cancel') cancelled = true;
    else outputLimitExceeded = true;
    options.transport?.stop?.();
    if (child.pid !== undefined) terminateTree(child.pid);
  };
  const timer = setTimeout(() => stop('timeout'), options.timeoutMs);
  const outputWatcher = setInterval(() => {
    if (fstatSync(stdoutFd).size > maximumPhaseOutputBytes || fstatSync(stderrFd).size > maximumPhaseOutputBytes) stop('output');
  }, 50);
  const onAbort = (): void => stop('cancel');
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  const closed = await new Promise<{ code: number | null; signal: string | null }>(resolvePromise => {
    child.on('error', error => {
      spawnError = error.message;
      resolvePromise({ code: null, signal: null });
    });
    child.on('close', (code, signal) => resolvePromise({ code, signal }));
  });

  clearTimeout(timer);
  clearInterval(outputWatcher);
  options.signal?.removeEventListener('abort', onAbort);
  closeSync(stdoutFd);
  closeSync(stderrFd);
  const transportState = options.transport?.finish?.(closed.code);
  if (transportState?.error) spawnError = transportState.error;
  const durationMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);
  for (const path of [stdoutPath, stderrPath, reportPath]) {
    if (existsSync(path) && statSync(path).size > maximumPhaseOutputBytes) {
      outputLimitExceeded = true;
      truncateSync(path, maximumPhaseOutputBytes);
      appendFileSync(path, '\n# FSA: output truncated after exceeding the 8 MiB limit\n');
    }
  }
  const stdout = readFileSync(stdoutPath, 'utf8');
  const stderr = readFileSync(stderrPath, 'utf8');

  return {
    kind: options.kind,
    isolation: options.transport === undefined ? 'none' : 'container',
    declaredCommand: [...options.declaredCommand],
    argv,
    cwd,
    timeoutMs: options.timeoutMs,
    exitCode: closed.code,
    signal: closed.signal,
    timedOut,
    cancelled,
    spawnError,
    oomKilled: transportState?.oomKilled ?? false,
    outputLimitExceeded,
    durationMs,
    stdout,
    stderr,
    stdoutPath,
    stderrPath,
    reportPath,
    resource: readResourceReport(reportPath),
    outcomes: parseTap(stdout),
  };
}

const memorySignatures = /heap out of memory|Allocation failed|Reached heap limit|out of memory/i;

/** 结论优先级：取消 > 基础设施故障 > 超时 > 内存耗尽 > 检查失败/通过。 */
export function classifyExecution(phases: readonly PhaseExecution[], checks: readonly ExecutionCheck[]): ExecutionClassification {
  if (phases.some(phase => phase.cancelled)) return 'cancelled';
  if (phases.some(phase => phase.outputLimitExceeded)) return 'check-failed';
  if (phases.some(phase => phase.spawnError !== null)) return 'infrastructure-error';
  // 容器档案下 125/126/127 是 docker 自身的失败码（参数、守护进程或固定命令无法启动），属于基础设施故障。
  if (phases.some(phase => phase.isolation === 'container' && !phase.timedOut && isContainerRuntimeFailure(phase.exitCode))) return 'infrastructure-error';
  if (phases.some(phase => phase.timedOut)) return 'timeout';
  if (phases.some(phase => phase.oomKilled)) return 'memory-exceeded';
  if (phases.some(phase => memorySignatures.test(phase.stderr))) return 'memory-exceeded';
  if (phases.some(phase => phase.exitCode !== 0 || phase.signal !== null)) return 'check-failed';
  if (checks.some(check => check.status !== 'passed')) return 'check-failed';
  return 'passed';
}

function artifactOf(id: string, path: string, root: string): ExecutionArtifact {
  const content = readFileSync(path);
  return {
    id,
    path: relative(root, path).split(sep).join('/'),
    sha256: createHash('sha256').update(content).digest('hex'),
    bytes: content.byteLength,
  };
}

export type QualityProvider = (context: {
  frozenDirectory: string;
  execution: ExecutionResult;
  manifest: ExecutionManifest;
  artifactDirectory: string;
  signal?: AbortSignal;
}) => Promise<QualityEvidence & { artifacts?: ExecutionArtifact[]; notes?: string[] }>;

export interface ExecuteOptions {
  store: RunStore;
  runId: string;
  attemptId: string;
  artifactDirectory?: string;
  /** 平台分配的短临时路径，避免 Windows 嵌套性能采样的工作目录超过进程启动限制。 */
  workspaceDirectory?: string;
  signal?: AbortSignal;
  /** 静态客观分规则；给出时对冻结后的工作区做一次测量。 */
  staticPolicy?: StaticPolicy;
  /** 独立评审判决；由调用方通过评审适配器取得，执行器只负责落盘与校验。 */
  review?: ReviewVerdict;
  /** 额外的质量证据（例如性能维度必须提供的 benchmark 客观分）。 */
  quality?: QualityEvidence;
  qualityProvider?: QualityProvider;
}

function checkRows(manifest: TaskManifest, phases: readonly PhaseExecution[]): ExecutionCheck[] {
  return manifest.checks.map(check => {
    const phase = phases.find(item => item.kind === check.kind);
    const outcome = phase?.outcomes.find(item => item.id === check.id);
    return {
      id: check.id,
      kind: check.kind,
      group: check.group,
      critical: check.critical,
      status: outcome === undefined ? 'not-run' as const : outcome.ok ? 'passed' as const : 'failed' as const,
      durationMs: outcome?.durationMs ?? null,
    };
  });
}

/**
 * 静态客观分只覆盖 typescript；其它运行时（如 F#）没有对应规则时返回 null，
 * 而不是把“没有 .ts 文件”的满分当成质量结论。
 */
export function staticObjectiveFor(task: TaskManifest, report: StaticReport): QualityEvidence['objective'] | null {
  if (task.runtime !== 'typescript') return null;
  return {
    simplicity: { score: report.scores.simplicity, evidence: [report.evidenceId], kind: 'static' },
    maintainability: { score: report.scores.maintainability, evidence: [report.evidenceId], kind: 'static' },
    decoupling: { score: report.scores.decoupling, evidence: [report.evidenceId], kind: 'static' },
  };
}

/** 组装容器阶段：docker 调用替换本地直接命令，采样报告写到容器内 /work 再由宿主读取。 */
export function containerTransport(input: {
  kind: 'public' | 'hidden';
  task: TaskManifest;
  manifest: Pick<ExecutionManifest, 'environment'>;
  runtime: ContainerRuntime;
  hiddenChecksDirectory: string;
  workspace: string;
  artifactDirectory: string;
  pidsLimit?: number;
}): PhaseTransport {
  const invocation = buildContainerInvocation({
    runtime: input.runtime,
    image: input.manifest.environment.image as string,
    imageDigest: input.manifest.environment.imageDigest as string,
    workspace: input.workspace,
    hiddenChecksDirectory: input.hiddenChecksDirectory,
    publicChecksDirectory: join(taskPackageDir(input.task.taskId), 'public-tests'),
    samplerHostPath,
    argv: buildContainerArgv(input.task.commands[input.kind], input.task.limits.memoryMb),
    limits: { cpus: input.task.limits.cpus, memoryMb: input.task.limits.memoryMb, pidsLimit: input.pidsLimit ?? defaultPidsLimit },
    resourceReportContainerPath: '/work/' + input.kind + '.resources.json',
  });
  return {
    argv: invocation.argv,
    cwd: invocation.cwd,
    env: invocation.environment,
    reportHostPath: join(input.workspace, input.kind + '.resources.json'),
    stop: () => {
      captureCommand([input.runtime.command, 'kill', invocation.name], {
        timeoutMs: 10_000, captureDir: input.artifactDirectory, label: input.kind + '.container-kill',
      });
    },
    finish: exitCode => {
      const state = captureCommand([input.runtime.command, 'inspect', '--format', '{{json .State}}', invocation.name], {
        timeoutMs: 10_000, captureDir: input.artifactDirectory, label: input.kind + '.container-state',
      });
      const removed = captureCommand([input.runtime.command, 'rm', '--force', invocation.name], {
        timeoutMs: 10_000, captureDir: input.artifactDirectory, label: input.kind + '.container-remove',
      });
      if (isContainerRuntimeFailure(exitCode)) return { oomKilled: false, error: null };
      if (state.exitCode !== 0 || removed.exitCode !== 0) {
        return { oomKilled: false, error: '容器状态读取或容器回收失败；原始命令输出已保留。' };
      }
      try {
        const parsed = JSON.parse(state.stdout) as { OOMKilled?: boolean };
        return { oomKilled: parsed.OOMKilled === true, error: null };
      } catch {
        return { oomKilled: false, error: '容器状态不是有效 JSON。' };
      }
    },
  };
}

/** 专用性能负载复用候选快照、环境与回收逻辑；命令只来自受信 grader。 */
export async function executeBenchmarkWorkload(options: Pick<ExecuteOptions, 'store' | 'runId' | 'attemptId' | 'signal'> & { artifactDirectory: string; workspace: string }) {
  const outcome = options.store.readAttempt(options.runId, options.attemptId);
  if (!outcome) throw new Error('性能作答快照不存在。');
  const manifest = outcome.manifest;
  const task = manifest.task;
  const grader = join(repositoryRoot, 'graders', task.taskId);
  if (!existsSync(join(grader, 'benchmark.ts'))) throw new Error('题目没有受信性能负载。');
  const workspace = options.workspace;
  options.store.materialize(options.runId, options.attemptId, workspace);
  const declaredCommand = ['node', '__checks__/benchmark.ts', '.'];
  let transport: PhaseTransport | undefined;
  if (manifest.environment.profile === 'linux-container') {
    if (platform() !== 'win32') chmodSync(workspace, 0o777);
    if (!manifest.environment.image || !manifest.environment.imageDigest) throw new InfrastructureUnavailableError('性能环境缺少固定镜像。');
    const runtime = probeContainerRuntime({ captureDir: options.artifactDirectory });
    requirePinnedImage(runtime, manifest.environment.image, manifest.environment.imageDigest, { captureDir: options.artifactDirectory });
    transport = containerTransport({ kind: 'hidden', task: { ...task, commands: { ...task.commands, hidden: declaredCommand } }, manifest, runtime,
      hiddenChecksDirectory: grader, workspace, artifactDirectory: options.artifactDirectory });
  } else {
    mkdirSync(join(workspace, '__checks__'), { recursive: true });
    copyFileSync(join(grader, 'benchmark.ts'), join(workspace, '__checks__', 'benchmark.ts'));
  }
  const phase = await runPhase({ kind: 'hidden', declaredCommand, workspace, artifactDir: options.artifactDirectory,
    timeoutMs: task.limits.timeoutMs, memoryMb: task.limits.memoryMb,
    ...(options.signal ? { signal: options.signal } : {}), ...(transport ? { transport } : {}) });
  if (phase.exitCode !== 0 || phase.timedOut || phase.cancelled || phase.spawnError || phase.oomKilled || phase.outputLimitExceeded) throw new Error('性能负载失败，原始进程输出已保留：' + (phase.spawnError ?? phase.stderr.slice(0, 1500)));
  const diagnostic: unknown = JSON.parse(phase.stdout);
  if (!diagnostic || typeof diagnostic !== 'object' || !('correctnessPassed' in diagnostic) || diagnostic.correctnessPassed !== true) throw new Error('性能负载未给出完整语义检查结论。');
  return { durationMs: phase.durationMs, diagnostic, resource: phase.resource };
}

export async function executeAttempt(options: ExecuteOptions): Promise<ExecutionResult> {
  const outcome = options.store.readAttempt(options.runId, options.attemptId);
  if (outcome === null) throw new Error(`未找到已冻结的 attempt：${options.runId}/${options.attemptId}`);
  const manifest = outcome.manifest;
  const task = manifest.task;
  if (options.review !== undefined && (!reviewVerdictValidator.Check(options.review)
    || options.review.runId !== options.runId || options.review.attemptId !== options.attemptId
    || options.review.taskId !== task.taskId || options.review.rubricVersion !== manifest.ruleVersion)) {
    throw new Error('独立评审不符合当前 attempt 或评分版本，拒绝复用。');
  }
  const containerProfile = manifest.environment.profile === 'linux-container';

  const artifactDirectory = options.artifactDirectory ?? join(outcome.directory, 'execution');
  if (options.artifactDirectory === undefined && existsSync(artifactDirectory)) {
    // 同一 attempt 的既有产物必须保留：重新执行是显式动作，不能覆盖上一次的证据。
    throw new Error(`该 attempt 已有执行产物：${artifactDirectory}；如需重新执行，请显式指定新的产物目录。`);
  }
  const workspace = options.workspaceDirectory ?? join(artifactDirectory, 'workspace');
  const notes: string[] = [];
  // 执行事件写在 attempt 目录里：同一 attempt 的重复执行会带上产物目录名，不会覆盖上一次记录。
  const executionTag = basename(artifactDirectory);
  const eventId = (type: string, extra?: string): string =>
    [type, options.runId, options.attemptId, executionTag, extra].filter((part): part is string => part !== undefined).join(':');
  const startedAt = new Date().toISOString();
  const startedHr = process.hrtime.bigint();

  // 物化会重算冻结快照摘要：存储被改写时这里就会失败，而不是把被篡改的内容当成被测对象。
  const materialized = options.store.materialize(options.runId, options.attemptId, workspace);
  installPublicChecks(task, workspace);
  notes.push('公开检查由平台题目包恢复，候选修改的检查文件不参与验收；Node 检查在独立测试进程执行，stdout 不能作为顶层 TAP 验收行。');

  // 容器档案：必须有可用运行时与按 digest 固定的本地镜像，否则直接拒绝执行。
  let runtime: ContainerRuntime | null = null;
  let imageReference: string | null = null;
  let hiddenChecksDirectory: string | null = null;
  if (containerProfile) {
    if (platform() !== 'win32') chmodSync(workspace, 0o777);
    const image = manifest.environment.image;
    const digest = manifest.environment.imageDigest;
    if (image === null || digest === null) {
      throw new InfrastructureUnavailableError('容器档案缺少镜像引用或 digest，拒绝执行。');
    }
    runtime = probeContainerRuntime({ captureDir: artifactDirectory });
    imageReference = requirePinnedImage(runtime, image, digest, { captureDir: artifactDirectory });
    hiddenChecksDirectory = join(repositoryRoot, task.grader.checks);
    notes.push(`容器档案：镜像 ${imageReference}，运行时 ${runtime.command} ${runtime.serverVersion}。`);
    notes.push('隐藏检查以只读方式挂载在 ' + hiddenChecksMount + '，不复制进候选树；候选仍可读取检查内容，物理保密需要容器外的独立验证进程。');
    notes.push('容器以 --network none 运行，并按 manifest 的 CPU/内存/PID 预算限额；pids-limit=' + defaultPidsLimit + '。');
  } else {
    installHiddenChecks(task, workspace);
    notes.push('被测对象来自冻结快照的受控物化；隐藏检查在物化之后由受信侧注入 __checks__/。');
    notes.push('profile=local：没有容器隔离，也没有网络阻断，检查与被测对象在同一主机同一用户下运行。');
  }
  notes.push(`node 命令以 --max-old-space-size=${task.limits.memoryMb} 运行；该项限制堆上限，峰值 RSS 可能更高。`);
  appendRunEvent(outcome.directory, {
    type: 'execution.started',
    actor: 'executor',
    candidateHash: materialized.treeHash,
    payload: { profile: manifest.environment.profile, isolation: containerProfile ? 'container' : 'none', artifactDirectory: executionTag },
    id: eventId('execution.started'),
    at: startedAt,
  });

  const phases: PhaseExecution[] = [];
  let halted: string | null = null;
  for (const kind of ['public', 'hidden'] as const) {
    if (halted !== null) {
      notes.push(`${kind} 阶段未运行：${halted}`);
      continue;
    }
    if (kind === 'hidden' && !containerProfile) installHiddenChecks(task, workspace);
    const phase = await runPhase({
      kind,
      declaredCommand: task.commands[kind],
      workspace,
      artifactDir: artifactDirectory,
      timeoutMs: task.limits.timeoutMs,
      memoryMb: task.limits.memoryMb,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(runtime === null || imageReference === null || hiddenChecksDirectory === null
        ? {}
        : {
            transport: containerTransport({
              kind, task, manifest, runtime, hiddenChecksDirectory, workspace, artifactDirectory,
            }),
          }),
    });
    phases.push(phase);
    if (phase.cancelled) halted = '已被取消';
    else if (phase.spawnError !== null) halted = `命令启动失败：${phase.spawnError}`;
    else if (phase.timedOut) halted = `超出 ${phase.timeoutMs}ms 预算`;
    else if (phase.oomKilled || memorySignatures.test(phase.stderr)) halted = '进程因内存耗尽终止';
  }

  const checks = checkRows(task, phases);
  const artifacts: ExecutionArtifact[] = [];
  for (const phase of phases) {
    appendRunEvent(outcome.directory, {
      type: 'check.finished',
      actor: 'executor',
      candidateHash: materialized.treeHash,
      payload: {
        phase: phase.kind,
        isolation: phase.isolation,
        exitCode: phase.exitCode,
        signal: phase.signal,
        timedOut: phase.timedOut,
        cancelled: phase.cancelled,
        durationMs: phase.durationMs,
        peakRssBytes: phase.resource.peakRssBytes,
        passed: phase.outcomes.filter(item => item.ok).map(item => item.id),
      },
      evidenceRefs: [phase.kind + '.stdout', phase.kind + '.stderr'],
      id: eventId('check.finished', phase.kind),
      at: new Date().toISOString(),
    });
  }
  for (const phase of phases) {
    artifacts.push(artifactOf(`${phase.kind}.stdout`, phase.stdoutPath, artifactDirectory));
    artifacts.push(artifactOf(`${phase.kind}.stderr`, phase.stderrPath, artifactDirectory));
    if (existsSync(phase.reportPath)) {
      const persisted = join(artifactDirectory, `${phase.kind}.resources.json`);
      if (resolve(phase.reportPath) !== resolve(persisted)) copyFileSync(phase.reportPath, persisted);
      artifacts.push(artifactOf(`${phase.kind}.resources`, persisted, artifactDirectory));
    }
  }

  const attemptRows = phases.map(phase => {
    const declaredChecks = task.checks.filter(check => check.kind === phase.kind).map(check => check.id);
    return {
      kind: phase.kind,
      declaredCommand: [...task.commands[phase.kind]],
      argv: phase.argv,
      cwd: phase.cwd,
      timeoutMs: phase.timeoutMs,
      exitCode: phase.exitCode,
      signal: phase.signal,
      timedOut: phase.timedOut,
      cancelled: phase.cancelled,
      outputLimitExceeded: phase.outputLimitExceeded ?? false,
      durationMs: phase.durationMs,
      resource: phase.resource,
      missing: declaredChecks.filter(id => !phase.outcomes.some(item => item.id === id)),
      artifacts: artifacts.filter(item => item.id.startsWith(`${phase.kind}.`)).map(item => item.id),
    };
  });
  for (const kind of ['public', 'hidden'] as const) {
    if (attemptRows.some(row => row.kind === kind)) continue;
    attemptRows.push({
      kind,
      declaredCommand: [...task.commands[kind]],
      argv: [...task.commands[kind]],
      cwd: workspace,
      timeoutMs: task.limits.timeoutMs,
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelled: false,
      outputLimitExceeded: false,
      durationMs: 0,
      resource: { peakRssBytes: null, userCpuMs: null, systemCpuMs: null, sampler: 'unavailable' },
      missing: task.checks.filter(check => check.kind === kind).map(check => check.id),
      artifacts: [],
    });
  }

  const result: ExecutionResult = {
    schemaVersion: '0.1.0',
    runId: options.runId,
    attemptId: options.attemptId,
    taskId: manifest.envelope.taskId,
    taskVersion: manifest.envelope.taskVersion,
    candidateTreeHash: materialized.treeHash,
    classification: classifyExecution(phases, checks),
    isolation: containerProfile ? 'container' : 'none',
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Math.round(Number(process.hrtime.bigint() - startedHr) / 1e6),
    environment: {
      profile: manifest.environment.profile,
      imageDigest: manifest.environment.imageDigest,
      platform: containerProfile ? 'linux (fixed image)' : `${platform()} ${arch()}`,
      platformVersion: containerProfile ? imageReference as string : process.version,
      candidateRuntimes: [...new Set([task.commands.public, task.commands.hidden].map(command => command[0] ?? '').filter(name => name.length > 0))],
      containerRuntime: runtime === null ? null : runtime.command + ' ' + runtime.serverVersion,
      image: imageReference,
      cpus: containerProfile ? task.limits.cpus : availableParallelism(),
      totalMemoryMb: containerProfile ? task.limits.memoryMb : Math.round(totalmem() / (1024 * 1024)),
      network: !containerProfile,
    },
    phases: attemptRows,
    checks,
    artifacts,
    evidenceRefs: artifacts.map(item => item.id),
    notes,
  };
  if (!executionResultValidator.Check(result)) {
    throw new Error(`执行结果不符合 0.1.0 协议：${explainExecutionResult(result).join('；')}`);
  }

  mkdirSync(artifactDirectory, { recursive: true });

  const score = await scoreAttemptExecution(options, outcome, result, artifactDirectory, eventId);
  result.notes = result.notes.slice(-32);
  if (!executionResultValidator.Check(result)) throw new Error('最终执行证据不符合协议：' + explainExecutionResult(result).join('；'));

  const resultPath = join(artifactDirectory, 'execution.json');
  writeFileSync(resultPath + '.tmp', `${JSON.stringify(result, null, 2)}\n`);
  renameSync(resultPath + '.tmp', resultPath);
  appendRunEvent(outcome.directory, {
    type: 'score.finalized',
    actor: 'executor',
    candidateHash: result.candidateTreeHash,
    payload: {
      mode: score.mode,
      functional: score.functional,
      quality: score.quality,
      total: score.total,
      readiness: score.readiness,
      criticalPassed: score.criticalPassed,
    },
    evidenceRefs: ['score.json'],
    id: eventId('score.finalized'),
    at: score.scoredAt,
  });
  appendRunEvent(outcome.directory, {
    type: 'execution.finished',
    actor: 'executor',
    candidateHash: result.candidateTreeHash,
    payload: {
      classification: result.classification,
      isolation: result.isolation,
      durationMs: result.durationMs,
      failed: checks.filter(check => check.status === 'failed').map(check => check.id),
      notRun: checks.filter(check => check.status === 'not-run').map(check => check.id),
    },
    evidenceRefs: result.evidenceRefs,
    id: eventId('execution.finished'),
    at: result.finishedAt,
  });
  return result;
}

async function scoreAttemptExecution(
  options: ExecuteOptions, outcome: SubmissionOutcome, result: ExecutionResult, artifactDirectory: string,
  eventId: (type: string, extra?: string) => string,
): Promise<ExecutionScore> {
  const task = outcome.manifest.task;
  const notes = result.notes;
  // 正式评分：可用验证分项由受控执行结果换算；质量证据缺失时保持 null（总分待定）。
  // 质量证据：静态客观分（可选规则）+ 评审判决（可选）+ 调用方补充（例如 benchmark）。
  let objective: QualityEvidence['objective'] = { ...(options.quality?.objective ?? {}) };
  let review: QualityEvidence['review'] = { ...(options.quality?.review ?? {}) };
  let qualityContext: QualityEvidence = options.quality ?? {};
  if (options.qualityProvider !== undefined) {
    try {
      const provided = await options.qualityProvider({
        frozenDirectory: join(outcome.directory, 'candidate'), execution: result,
        manifest: outcome.manifest, artifactDirectory,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      scoreExecution(result, task, provided);
      objective = { ...objective, ...provided.objective };
      review = { ...review, ...provided.review };
      qualityContext = { ...qualityContext, ...provided };
      for (const artifact of provided.artifacts ?? []) {
        const path = resolve(artifactDirectory, artifact.path);
        const scope = relative(artifactDirectory, path);
        if (isAbsolute(scope) || scope.startsWith('..') || artifactOf(artifact.id, path, artifactDirectory).sha256 !== artifact.sha256) {
          throw new Error('质量证据路径或摘要不一致。');
        }
        result.artifacts.push(artifact);
        result.evidenceRefs.push(artifact.id);
      }
      notes.push(...(provided.notes ?? []));
    } catch (error) {
      objective = { ...(options.quality?.objective ?? {}) };
      review = { ...(options.quality?.review ?? {}) };
      qualityContext = options.quality ?? {};
      notes.push('质量评估未完成：' + (error instanceof Error ? error.message : String(error)));
    }
  }
  if (options.staticPolicy !== undefined) {
    const report = analyzeWorkspace(join(outcome.directory, 'candidate'), options.staticPolicy);
    const staticPath = join(artifactDirectory, 'static.json');
    writeFileSync(staticPath, JSON.stringify(report, null, 2) + '\n');
    result.artifacts.push(artifactOf('static.json', staticPath, artifactDirectory));
    result.evidenceRefs = [...result.evidenceRefs, 'static.json'];
    const staticObjective = staticObjectiveFor(task, report);
    if (staticObjective === null) {
      notes.push('静态规则只覆盖 typescript，本题运行时是 ' + task.runtime + '：静态客观分未校准，保持缺失（不得当作满分）。');
    } else {
      objective = { ...objective, ...staticObjective };
    }
    appendRunEvent(outcome.directory, {
      type: 'static.analyzed',
      actor: 'executor',
      candidateHash: result.candidateTreeHash,
      payload: { ruleVersion: report.ruleVersion, scores: report.scores, violations: report.violations.length },
      evidenceRefs: ['static.json'],
      id: eventId('static.analyzed'),
    });
    if (task.runtime === 'typescript') {
      notes.push('静态客观分按规则版本 ' + report.ruleVersion + ' 测量，违规 ' + report.violations.length + ' 条；它只覆盖 simplicity/maintainability/decoupling。');
    }
  }
  if (options.review !== undefined) {
    const reviewPath = join(artifactDirectory, 'review.json');
    writeFileSync(reviewPath, JSON.stringify(options.review, null, 2) + '\n');
    result.artifacts.push(artifactOf('review.json', reviewPath, artifactDirectory));
    result.evidenceRefs = [...result.evidenceRefs, 'review.json'];
    const dimensions = options.review.dimensions;
    review = {
      ...review,
      simplicity: { score: dimensions.simplicity.score, evidence: dimensions.simplicity.evidence },
      maintainability: { score: dimensions.maintainability.score, evidence: dimensions.maintainability.evidence },
      decoupling: { score: dimensions.decoupling.score, evidence: dimensions.decoupling.evidence },
      performance: { score: dimensions.performance.score, evidence: dimensions.performance.evidence },
    };
    appendRunEvent(outcome.directory, {
      type: 'review.finished',
      actor: options.review.model,
      candidateHash: result.candidateTreeHash,
      payload: { model: options.review.model, promptVersion: options.review.promptVersion, cost: options.review.cost },
      evidenceRefs: ['review.json'],
      id: eventId('review.finished'),
    });
    notes.push('独立评审来自 ' + options.review.model + '（提示版本 ' + options.review.promptVersion + '），成本记录在 review.json。');
  }
  // SDK 错误堆栈可能超过协议说明字段的 2000 字符上限；完整内容作为证据保留。
  if (notes.some(note => note.length > 2000)) {
    const notesPath = join(artifactDirectory, 'execution-notes.json');
    writeFileSync(notesPath, JSON.stringify(notes, null, 2) + '\n');
    result.artifacts.push(artifactOf('execution-notes', notesPath, artifactDirectory));
    result.evidenceRefs.push('execution-notes');
    result.notes = notes.map(note => note.length <= 2000 ? note : note.slice(0, 1900) + '…（完整说明见 execution-notes.json）');
  }
  const score = scoreExecution(result, task, { ...qualityContext, objective, review });
  if (!executionScoreValidator.Check(score)) throw new Error('执行评分不符合 0.1.0 协议。');
  const scorePath = join(artifactDirectory, 'score.json');
  writeFileSync(scorePath, `${JSON.stringify(score, null, 2)}\n`);
  result.artifacts.push(artifactOf('score.json', scorePath, artifactDirectory));
  result.evidenceRefs = [...result.evidenceRefs, 'score.json'];

  return score;
}

function nextArtifactDirectory(attemptDirectory: string): string {
  const base = join(attemptDirectory, 'execution');
  if (!existsSync(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error('执行产物目录过多，拒绝继续。');
}

/** 读取已记录的执行结果；没有则返回 null。用于重复完成事件与进程重启后的复用。 */
export function completedExecutionDirectory(attemptDirectory: string): string | null {
  if (!existsSync(attemptDirectory)) return null;
  const directories = readdirSync(attemptDirectory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^execution(?:-[1-9][0-9]*)?$/.test(entry.name))
    .map(entry => entry.name)
    .sort((left, right) => Number(right.split('-')[1] ?? 1) - Number(left.split('-')[1] ?? 1));
  for (const directory of directories) {
    const path = join(attemptDirectory, directory);
    if (existsSync(join(path, 'execution.json'))) return path;
  }
  return null;
}

export function readExecutionResult(attemptDirectory: string): ExecutionResult | null {
  const directory = completedExecutionDirectory(attemptDirectory);
  if (directory === null) return null;
  const path = join(directory, 'execution.json');
  const input: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!executionResultValidator.Check(input)) throw new Error('已记录的执行结果不符合 0.1.0 协议。');
  return input;
}

/** 读取正式评分文档；没有执行结论时为 null。 */
export function readExecutionScore(attemptDirectory: string): ExecutionScore | null {
  const directory = completedExecutionDirectory(attemptDirectory);
  if (directory === null) return null;
  const path = join(directory, 'score.json');
  if (!existsSync(path)) return null;
  const input: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!executionScoreValidator.Check(input)) throw new Error('已记录的执行评分不符合 0.1.0 协议。');
  return input;
}

/** 显式补评：复用原始执行证据，在新目录保存分数修订，不重跑候选或覆盖原分数。 */
export async function reviewCompletedAttempt(options: ExecuteOptions): Promise<ExecutionScore> {
  const outcome = options.store.readAttempt(options.runId, options.attemptId);
  if (outcome === null) throw new Error('未找到已冻结的 attempt。');
  if (activeVerifications.has(outcome.directory)) throw new Error('该 attempt 正在执行或补评。');
  const previousDirectory = completedExecutionDirectory(outcome.directory);
  const recorded = readExecutionResult(outcome.directory);
  if (previousDirectory === null || recorded === null) throw new Error('尚无执行结论，不能补评。');
  const frozenDirectory = join(outcome.directory, 'candidate');
  if (recorded.candidateTreeHash !== outcome.attempt.treeHash
    || digestTree(frozenDirectory, { excluded: outcome.attempt.excluded }).treeHash !== recorded.candidateTreeHash) {
    throw new Error('冻结快照或已记录的执行结果摘要不一致。');
  }
  if (options.review !== undefined && (!reviewVerdictValidator.Check(options.review)
    || options.review.runId !== options.runId || options.review.attemptId !== options.attemptId
    || options.review.taskId !== recorded.taskId || options.review.rubricVersion !== outcome.manifest.ruleVersion)) {
    throw new Error('独立评审不符合当前 attempt 或评分版本，拒绝复用。');
  }
  const artifactDirectory = nextArtifactDirectory(outcome.directory);
  mkdirSync(artifactDirectory);
  const result = structuredClone(recorded);
  const originalPhaseArtifacts = new Set(result.phases.flatMap(phase => phase.artifacts));
  result.artifacts = result.artifacts.filter(artifact => originalPhaseArtifacts.has(artifact.id));
  result.evidenceRefs = result.artifacts.map(artifact => artifact.id);
  for (const artifact of result.artifacts) {
    const source = resolve(previousDirectory, artifact.path);
    const scope = relative(previousDirectory, source);
    if (isAbsolute(scope) || scope.startsWith('..') || artifactOf(artifact.id, source, previousDirectory).sha256 !== artifact.sha256) {
      throw new Error('原始执行证据路径或摘要不一致，拒绝补评。');
    }
    const destination = join(artifactDirectory, artifact.path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
  result.notes.push('本记录为显式补评修订，复用 ' + basename(previousDirectory) + ' 的执行结论，未重新运行候选；原分数保留。');
  const tag = basename(artifactDirectory);
  const eventId = (type: string): string => [type, options.runId, options.attemptId, tag].join(':');
  const running = (async () => {
    const score = await scoreAttemptExecution(options, outcome, result, artifactDirectory, eventId);
    result.notes = result.notes.slice(-32);
    if (!executionResultValidator.Check(result)) throw new Error('补评执行证据不符合协议：' + explainExecutionResult(result).join('；'));
    const resultPath = join(artifactDirectory, 'execution.json');
    writeFileSync(resultPath + '.tmp', JSON.stringify(result, null, 2) + '\n');
    renameSync(resultPath + '.tmp', resultPath);
    appendRunEvent(outcome.directory, {
      type: 'score.finalized', actor: 'executor', candidateHash: result.candidateTreeHash,
      payload: { mode: score.mode, total: score.total, revision: tag, previous: basename(previousDirectory) },
      evidenceRefs: result.evidenceRefs, id: eventId('score.finalized'), at: score.scoredAt,
    });
    return result;
  })();
  activeVerifications.set(outcome.directory, running);
  try {
    await running;
    const score = readExecutionScore(outcome.directory);
    if (score === null) throw new Error('补评结果未保存。');
    return score;
  } finally {
    activeVerifications.delete(outcome.directory);
  }
}

export interface VerifySubmissionRequest {
  store: RunStore;
  taskId: string;
  envelope: unknown;
  candidateDirectory: string;
  submittedBy: string;
  profile?: 'local' | 'linux-container';
  image?: string | null;
  imageDigest?: string | null;
  signal?: AbortSignal;
  workspaceDirectory?: string;
  /** 透传给执行器的质量证据：静态规则、评审判决与调用方补充（例如 benchmark 客观分）。 */
  staticPolicy?: StaticPolicy;
  review?: ReviewVerdict;
  quality?: QualityEvidence;
  qualityProvider?: QualityProvider;
}

export interface VerificationOutcome {
  submission: SubmissionOutcome;
  execution: ExecutionResult;
  reusedExecution: boolean;
}

const activeVerifications = new Map<string, Promise<ExecutionResult>>();

/**
 * 显式提交入口：冻结候选并自动触发验证。
 * 已确认的执行副作用（execution.json）一律复用，因此重复完成事件与进程重启都不会重跑检查。
 */
export async function verifySubmission(request: VerifySubmissionRequest): Promise<VerificationOutcome> {
  const submission = request.store.submit({
    taskId: request.taskId,
    envelope: request.envelope,
    candidateDirectory: request.candidateDirectory,
    submittedBy: request.submittedBy,
    ...(request.profile === undefined ? {} : { profile: request.profile }),
    ...(request.image === undefined ? {} : { image: request.image }),
    ...(request.imageDigest === undefined ? {} : { imageDigest: request.imageDigest }),
  });
  const recorded = readExecutionResult(submission.directory);
  if (recorded !== null) {
    appendRunEvent(submission.directory, {
      type: 'execution.reused',
      actor: request.submittedBy,
      candidateHash: recorded.candidateTreeHash,
      payload: { classification: recorded.classification, finishedAt: recorded.finishedAt },
      evidenceRefs: recorded.evidenceRefs,
      id: 'execution.reused:' + submission.attempt.runId,
    });
    return { submission, execution: recorded, reusedExecution: true };
  }
  const active = activeVerifications.get(submission.directory);
  if (active !== undefined) return { submission, execution: await active, reusedExecution: true };
  const running = executeAttempt({
    store: request.store,
    runId: submission.attempt.runId,
    attemptId: submission.attempt.attemptId,
    artifactDirectory: nextArtifactDirectory(submission.directory),
    ...(request.workspaceDirectory === undefined ? {} : { workspaceDirectory: request.workspaceDirectory }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.staticPolicy === undefined ? {} : { staticPolicy: request.staticPolicy }),
    ...(request.review === undefined ? {} : { review: request.review }),
    ...(request.quality === undefined ? {} : { quality: request.quality }),
    ...(request.qualityProvider === undefined ? {} : { qualityProvider: request.qualityProvider }),
  });
  activeVerifications.set(submission.directory, running);
  try {
    return { submission, execution: await running, reusedExecution: false };
  } finally {
    activeVerifications.delete(submission.directory);
  }
}

/** 显式同快照重试，仅接受尚未取得结果、基础设施失败或取消的 attempt。 */
export async function retryCompletedAttempt(options: ExecuteOptions): Promise<ExecutionResult> {
  const outcome = options.store.readAttempt(options.runId, options.attemptId);
  if (!outcome) throw new Error('未找到已冻结的 attempt。');
  const active = activeVerifications.get(outcome.directory);
  if (active) return active;
  const previous = readExecutionResult(outcome.directory);
  if (previous && !['infrastructure-error', 'cancelled'].includes(previous.classification)) throw new Error('只有基础设施失败或取消允许同快照重试。');
  const running = executeAttempt({ ...options, artifactDirectory: nextArtifactDirectory(outcome.directory) });
  activeVerifications.set(outcome.directory, running);
  try { return await running; }
  finally { activeVerifications.delete(outcome.directory); }
}

/** 查询输出：当前阶段、已知失败、可重试原因、证据引用；评审未接入时总分待定。 */
export function readRunStatus(store: RunStore, runId: string, attemptId: string): RunStatus {
  const outcome = store.readAttempt(runId, attemptId);
  if (outcome === null) throw new Error(`未找到已冻结的 attempt：${runId}/${attemptId}`);
  const execution = readExecutionResult(outcome.directory);
  if (execution !== null && (execution.candidateTreeHash !== outcome.attempt.treeHash || execution.runId !== runId || execution.attemptId !== attemptId)) {
    throw new Error('执行结果与冻结 attempt 不一致，拒绝复用。');
  }
  const score = readExecutionScore(outcome.directory);
  const checks = execution?.checks ?? [];
  const classification = execution?.classification ?? null;
  const retryable = execution === null || classification === 'infrastructure-error' || classification === 'cancelled';
  const status: RunStatus = {
    schemaVersion: '0.1.0',
    runId,
    attemptId,
    taskId: outcome.attempt.taskId,
    taskVersion: outcome.attempt.taskVersion,
    phase: execution === null ? 'frozen' : 'verified',
    classification,
    candidateTreeHash: outcome.attempt.treeHash,
    frozenAt: outcome.attempt.frozenAt,
    verifiedAt: execution?.finishedAt ?? null,
    knownFailures: checks.filter(check => check.status === 'failed').map(check => ({ id: check.id, kind: check.kind, critical: check.critical })),
    missingChecks: checks.filter(check => check.status === 'not-run').map(check => check.id),
    retryable: { allowed: retryable, reason: retryable ? classification : null, sameSnapshotOnly: retryable },
    scoring: score === null
      ? { mode: 'pending', functional: null, quality: null, total: null, reason: '尚未取得受控执行结论，总分待定。' }
      : {
          mode: score.mode === 'formal' && execution?.isolation !== 'container' ? 'local' : score.mode,
          functional: score.functional,
          quality: score.quality,
          total: score.total,
          reason: score.reasons.length > 0 ? score.reasons.join(' ') : '按规则版本 ' + score.rubricVersion + ' 计算，无异常说明。',
        },
    evidenceRefs: execution?.evidenceRefs ?? [],
    artifacts: execution?.artifacts ?? [],
    updatedAt: execution?.finishedAt ?? outcome.attempt.frozenAt,
  };
  if (!runStatusValidator.Check(status)) throw new Error('运行状态不符合 0.1.0 协议。');
  return status;
}

/** 列出运行索引里每个 attempt 的当前状态。 */
export function listRunStatuses(store: RunStore): RunStatus[] {
  return store.list().map(entry => readRunStatus(store, entry.runId, entry.attemptId));
}

/**
 * 报告导出：把一次 attempt 的运行状态渲染成 Markdown，供面板下载或人工复核使用。
 * 只包含受控链路实际产出的结论与证据引用；代码质量缺失时明确写“待定”。
 */
export function renderRunReport(store: RunStore, runId: string, attemptId: string): string {
  const status = readRunStatus(store, runId, attemptId);
  const score = readExecutionScore(store.readAttempt(runId, attemptId)?.directory ?? '');
  const execution = readExecutionResult(store.readAttempt(runId, attemptId)?.directory ?? '');
  const lines: string[] = [];
  lines.push('# 运行报告 ' + status.taskId + ' ' + status.taskVersion);
  lines.push('');
  lines.push('- 运行 / 尝试：`' + status.runId + '` / `' + status.attemptId + '`');
  lines.push('- 阶段：' + status.phase + '；执行结论：' + (status.classification ?? '尚未执行'));
  lines.push('- 候选摘要：`' + status.candidateTreeHash + '`');
  lines.push('- 冻结时间：' + status.frozenAt + (status.verifiedAt === null ? '' : '；验证时间：' + status.verifiedAt));
  lines.push('');
  lines.push('## 检查结果');
  lines.push('');
  lines.push('| 检查 | 分组 | 关键项 | 状态 |');
  lines.push('| --- | --- | --- | --- |');
  for (const check of score?.groups.flatMap(group => group.passed.map(id => ({ id, group: group.group, status: 'passed' })).concat(group.failed.map(id => ({ id, group: group.group, status: 'failed' }))).concat(group.notRun.map(id => ({ id, group: group.group, status: 'not-run' })))) ?? []) {
    const critical = execution?.checks.some(item => item.id === check.id && item.critical) ?? false;
    lines.push('| `' + check.id + '` | ' + check.group + ' | ' + (critical ? '是' : '') + ' | ' + check.status + ' |');
  }
  if (status.knownFailures.length === 0) lines.push('');
  lines.push('');
  lines.push('## 评分');
  lines.push('');
  lines.push('- 可用验证：' + (status.scoring.functional === null ? '未取得' : status.scoring.functional + ' / 50'));
  lines.push('- 代码质量：' + (status.scoring.quality === null ? '待定（客观分或评审分缺失）' : status.scoring.quality + ' / 50'));
  lines.push('- 总分：' + (status.scoring.total === null ? '待定' : status.scoring.total + ' / 100'));
  if (score !== null) {
    lines.push('- 质量维度：' + JSON.stringify(score.dimensions));
    lines.push('- 门槛：' + (score.thresholdMet === null ? '待定' : String(score.thresholdMet)));
  }
  if (status.scoring.reason !== '') lines.push('- 说明：' + status.scoring.reason);
  lines.push('');
  lines.push('## 证据');
  lines.push('');
  lines.push(status.evidenceRefs.length === 0 ? '无' : status.evidenceRefs.map(ref => '`' + ref + '`').join('、'));
  if (status.artifacts.length > 0) {
    lines.push('');
    lines.push('| 证据 | 路径 | 字节 | 摘要 |');
    lines.push('| --- | --- | ---: | --- |');
    for (const artifact of status.artifacts) {
      lines.push('| `' + artifact.id + '` | `' + artifact.path + '` | ' + artifact.bytes + ' | `' + artifact.sha256.slice(0, 12) + '…` |');
    }
  }
  lines.push('');
  lines.push('> 报告由受控执行链产出：候选来自冻结快照，检查结论来自平台解析，代码质量在证据不全时保持待定。');
  lines.push('');
  return lines.join('\n');
}
