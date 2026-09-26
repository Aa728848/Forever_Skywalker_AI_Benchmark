/**
 * 受控实验 supervisor：API 与 dsh-compare 子进程之间唯一的中间层。
 *
 *   API --spawn(detached)--> supervisor --spawn--> dsh-compare 子进程
 *
 * 存在的理由（前几版设计失败的根因）：
 * - API 直接 spawn 时，API 崩溃在 spawn 之后、PID 落盘之前，子进程会无主且继续消耗模型预算；
 * - 后代进程命令行不含我们的标记，扫不到；父进程先退出后 taskkill /T 也找不到整棵树；
 * - API 不是父进程，收不到 exit 事件，重启后无法区分「正常跑完」和「被杀了」。
 *
 * 职责（按序）：
 * 1. 自登记握手：启动后第一件事是把 { pid, pidStartedAt, supervisorToken, state: 'registered' } 原子写入启动记录，然后才 spawn 子进程。
 * 2. 子进程执行前授权屏障：重读启动记录并复核 supervisorToken 与租约，不匹配即拒绝执行；令牌经环境变量交给子进程，
 *    子进程（scripts/dsh-compare.ts）在开工前做同样的校验。
 * 3. 租约心跳：每 5 秒原子更新 heartbeatAt；租约 TTL 30 秒。
 * 4. 持有进程树：POSIX 用 detached: true 建独立进程组并以组为单位终止；Windows 下 supervisor 全程存活，
 *    因此 taskkill /pid <childPid> /t 始终能找到整棵树。
 * 5. 持久化退出事实：子进程 exit 时立即原子写退出事实文件，再自己退出。
 * 6. 代理取消：轮询取消标记文件，按优雅→强制升级终止并确认退出。
 *
 * 本模块同时导出进程身份与终止原语，供 apps/api/src/launches.ts 复用（同一事实只有一个家）。
 * 直接执行时使用 argv 数组 + shell: false 启动子进程，绝不拼命令字符串。
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** 指定启动记录的 argv 开关；同时充当"作为程序运行"的判据（被 import 时 argv 里没有它）。 */
export const launchRecordFlag = '--launch-record';
/** 租约 TTL：超过它没有心跳就认为 supervisor 已不在。 */
export const defaultLeaseTtlMs = 30_000;
/** 心跳间隔。 */
export const defaultHeartbeatMs = 5_000;
/** 取消标记轮询间隔。 */
export const cancelPollMs = 250;
/** 优雅终止后等待多长时间升级为强制终止。 */
export const gracefulGraceMs = 5_000;
/** 终止后轮询确认退出的上限。 */
export const terminationConfirmMs = 10_000;

export interface ExitFact {
  /** 子进程退出码；被信号终止或 spawn 失败时为 null。 */
  code: number | null;
  signal: string | null;
  at: string;
  /** 是否已确认整棵后代进程树都退出了；无法确认时为 false（不谎报）。 */
  descendantsVerified: boolean;
  /** 退出事件的补充说明（spawn 失败、启动前取消等）；没有则为 null。 */
  note: string | null;
  /**
   * 本次退出是否由操作者取消引起。Windows 上 taskkill /f 只给出退出码 1、不带信号，
   * 因此取消事实必须显式落盘，绝不能靠信号推断。
   */
  cancelled: boolean;
}

export type Ownership = 'alive' | 'dead' | 'unconfirmed';

/* ------------------------------------------------------------------ *
 * 原子 JSON 读写
 * ------------------------------------------------------------------ */

export function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = path + '.tmp';
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
  renameSync(temporary, path);
}

export function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

/** 读改写启动记录：先读当前内容再原子替换，不丢其它写者已经落下的字段。 */
export function updateRecord(recordPath: string, patch: Record<string, unknown>): Record<string, unknown> | null {
  const current = readJsonObject(recordPath);
  if (current === null) return null;
  const next = { ...current, ...patch };
  writeJsonAtomic(recordPath, next);
  return next;
}

/* ------------------------------------------------------------------ *
 * 进程身份：绝不能只看 pid 存在
 * ------------------------------------------------------------------ */

const startTimeCache = new Map<number, { checkedAt: number; value: string | null }>();
/** 进程启动时间的缓存时长：GET 列表会反复探测，缓存避免每次请求都起一次 PowerShell。 */
export const startTimeCacheMs = 3_000;

let powershellBinaryCache: string | null | undefined;

/** 本机可用的 PowerShell：优先 pwsh，其次 Windows PowerShell；都没有则返回 null（如实降级）。 */
export function powershellBinary(): string | null {
  if (powershellBinaryCache !== undefined) return powershellBinaryCache;
  powershellBinaryCache = null;
  for (const candidate of ['pwsh', 'powershell']) {
    try {
      const probe = spawnSync(candidate, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { stdio: 'ignore', timeout: 10_000, windowsHide: true });
      if (probe.status === 0) { powershellBinaryCache = candidate; break; }
    } catch { /* 换下一个候选 */ }
  }
  return powershellBinaryCache;
}

function powerShellArgs(script: string): string[] {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script];
}

/**
 * 进程启动时间（ISO 字符串）。平台取不到时返回 null，调用方必须如实降级为「无法确认归属」。
 * - win32：Get-CimInstance Win32_Process 的 CreationDate；
 * - linux：/proc/<pid> 的 mtime（内核在进程创建时设置）；
 * - darwin：ps -o lstart=（秒级精度）。
 */
export function processStartTime(pid: number, options: { cache?: boolean } = {}): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const cached = startTimeCache.get(pid);
  if (options.cache !== false && cached !== undefined && Date.now() - cached.checkedAt < startTimeCacheMs) return cached.value;
  const value = probeStartTime(pid);
  startTimeCache.set(pid, { checkedAt: Date.now(), value });
  return value;
}

function probeStartTime(pid: number): string | null {
  if (process.platform === 'win32') {
    const shell = powershellBinary();
    if (shell === null) return null;
    const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($null -eq $p) { '' } else { $p.CreationDate.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ") }`;
    // 负载高时 pwsh 启动 + CIM 查询可能超过 10 秒；超时视为「取不到启动时间」，调用方如实降级。
    const result = spawnSync(shell, powerShellArgs(script), { encoding: 'utf8', timeout: 20_000, windowsHide: true });
    if (result.status !== 0) return null;
    const text = (result.stdout ?? '').trim();
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  if (process.platform === 'linux') {
    try { return new Date(statSync('/proc/' + pid).mtimeMs).toISOString(); } catch { return null; }
  }
  if (process.platform === 'darwin') {
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 10_000 });
    if (result.status !== 0) return null;
    const parsed = Date.parse((result.stdout ?? '').trim());
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  return null;
}

export function isAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** 启动时间比对容差：darwin 的 ps 只有秒级精度。 */
export const startTimeToleranceMs = 2_000;

/**
 * 归属判定，三态：
 * - dead：pid 不存在，或启动时间与记录明显不符（pid 已被复用）；
 * - alive：pid 存在且启动时间与记录一致；
 * - unconfirmed：pid 存在，但记录没有启动时间、或本平台取不到启动时间——不假装确认。
 */
export function probeOwnership(pid: number | null, pidStartedAt: string | null): Ownership {
  if (pid === null || !Number.isSafeInteger(pid) || pid <= 0) return 'unconfirmed';
  if (!isAlive(pid)) return 'dead';
  if (typeof pidStartedAt !== 'string' || pidStartedAt === '') return 'unconfirmed';
  const expected = Date.parse(pidStartedAt);
  if (!Number.isFinite(expected)) return 'unconfirmed';
  const actual = processStartTime(pid);
  if (actual === null) return 'unconfirmed';
  return Math.abs(Date.parse(actual) - expected) <= startTimeToleranceMs ? 'alive' : 'dead';
}

/* ------------------------------------------------------------------ *
 * 进程树终止与残留判定
 * ------------------------------------------------------------------ */

/**
 * 终止一棵进程树。POSIX 以独立进程组为单位（detached: true 时 pgid === pid）；
 * Windows 用 taskkill /t 沿父子链回收，因此要求 supervisor 全程存活，或退而用仍存活的中层 pid。
 */
export function terminateTree(pid: number, options: { force?: boolean } = {}): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  const force = options.force !== false;
  if (process.platform === 'win32') {
    const argv = ['/pid', String(pid), '/t', ...(force ? ['/f'] : [])];
    spawnSync('taskkill', argv, { stdio: 'ignore', windowsHide: true, timeout: 20_000 });
    return;
  }
  const signal = force ? 'SIGKILL' : 'SIGTERM';
  try { process.kill(-pid, signal); }
  catch { try { process.kill(pid, signal); } catch { /* 进程已退出。 */ } }
}

/**
 * 直接子进程列表。Windows 用 Win32_Process 的 ParentProcessId（进程已退出时该字段仍保留原父 pid，
 * 因此能看见被遗弃的后代）；扫描不可用时返回 null，调用方不得据此声称「无残留」。
 * POSIX 不枚举后代：终止以进程组为单位，残留判定用 descendantsGone 的组存在性检查。
 */
export function childrenOf(pid: number): number[] | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform !== 'win32') return null;
  const shell = powershellBinary();
  if (shell === null) return null;
  const script = `@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Select-Object -ExpandProperty ProcessId) -join ','`;
  const result = spawnSync(shell, powerShellArgs(script), { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  if (result.status !== 0) return null;
  const text = (result.stdout ?? '').trim();
  if (text === '') return [];
  return text.split(',').map(value => Number(value.trim())).filter(value => Number.isSafeInteger(value) && value > 0);
}

/** 整棵后代进程树是否都已退出；无法确认时返回 false（调用方写成 descendantsVerified: false）。 */
export function descendantsGone(rootPid: number): boolean {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) return false;
  if (process.platform === 'win32') {
    const children = childrenOf(rootPid);
    return children !== null && children.length === 0;
  }
  try { process.kill(-rootPid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'EPERM'; }
}

/* ------------------------------------------------------------------ *
 * supervisor 主流程
 * ------------------------------------------------------------------ */

const stamp = (): string => new Date().toISOString();

function argumentValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0 || index + 1 >= process.argv.length) return null;
  return process.argv[index + 1] ?? null;
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function stringArrayOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function writeExitFact(exitPath: string, fact: ExitFact): void {
  mkdirSync(dirname(exitPath), { recursive: true });
  writeJsonAtomic(exitPath, fact);
}

/** 子进程脚本按扩展名决定是否加载 tsx：测试用的假脚本是 .mjs，不加载。 */
function childArgv(childScript: string, childArgs: readonly string[]): string[] {
  const loader = /\.tsx?$/.test(childScript) ? ['--import', 'tsx'] : [];
  return [...loader, childScript, ...childArgs];
}

export interface SuperviseOutcome {
  exitCode: number;
  note: string | null;
}

/**
 * 完整执行一次受控监督，返回 supervisor 自己的退出码。
 * 任何早退路径都要么已经写出启动记录事实，要么在 stderr 说明拒绝原因（不假装执行过）。
 */
export async function supervise(recordPath: string): Promise<SuperviseOutcome> {
  const refuse = (message: string): SuperviseOutcome => {
    process.stderr.write('supervisor 拒绝执行：' + message + '\n');
    return { exitCode: 3, note: message };
  };
  const initial = readJsonObject(recordPath);
  if (initial === null) return refuse('启动记录不存在或不可读（' + recordPath + '）。');
  const token = textOf(initial.supervisorToken);
  if (token === null) return refuse('启动记录缺少 supervisorToken。');
  const childScript = textOf(initial.childScript);
  if (childScript === null || !existsSync(resolve(childScript))) return refuse('启动记录指定的子进程脚本不存在：' + String(childScript) + '。');
  const childArgs = stringArrayOf(initial.childArgs);
  const exitPath = resolve(textOf(initial.exitPath) ?? recordPath.replace(/\.json$/, '') + '.exit.json');
  const cancelPath = resolve(textOf(initial.cancelPath) ?? recordPath.replace(/\.json$/, '') + '.cancel-requested');
  const logPath = textOf(initial.logPath);
  const leaseTtlMs = typeof initial.leaseTtlMs === 'number' && Number.isFinite(initial.leaseTtlMs) ? initial.leaseTtlMs : defaultLeaseTtlMs;
  const heartbeatMs = typeof initial.heartbeatMs === 'number' && Number.isFinite(initial.heartbeatMs) ? initial.heartbeatMs : defaultHeartbeatMs;

  // 1. 自登记握手：先落盘，再 spawn 子进程。
  const pidStartedAt = processStartTime(process.pid, { cache: false });
  const registeredAt = stamp();
  updateRecord(recordPath, { pid: process.pid, pidStartedAt, supervisorToken: token, state: 'registered', registeredAt, heartbeatAt: registeredAt, leaseTtlMs, heartbeatMs });

  // 2. 子进程执行前的授权屏障：复核刚写下的登记事实。
  const registered = readJsonObject(recordPath);
  if (registered === null || registered.supervisorToken !== token || registered.pid !== process.pid || registered.state !== 'registered') {
    return refuse('自登记复核失败：启动记录与登记的 supervisor 不一致。');
  }
  const heartbeatAt = typeof registered.heartbeatAt === 'string' ? Date.parse(registered.heartbeatAt) : NaN;
  if (!Number.isFinite(heartbeatAt) || Date.now() - heartbeatAt > leaseTtlMs) return refuse('自登记租约无效，未通过授权屏障。');

  // 启动前已请求取消：不 spawn 子进程，直接留下退出事实。
  if (existsSync(cancelPath)) {
    writeExitFact(exitPath, { code: null, signal: 'cancel-requested', at: stamp(), descendantsVerified: true, note: '取消请求先于子进程启动；未执行任何作答。', cancelled: true });
    updateRecord(recordPath, { childExitedAt: stamp(), exitCode: null });
    return { exitCode: 0, note: '取消先于启动' };
  }

  let logFd: number | null = null;
  if (logPath !== null) {
    try { mkdirSync(dirname(resolve(logPath)), { recursive: true }); logFd = openSync(resolve(logPath), 'a'); }
    catch { logFd = null; }
  }
  const log = (message: string): void => { if (logFd !== null) { try { writeFileSync(logFd, '[' + stamp() + '] ' + message + '\n'); } catch { /* 日志失败不影响主流程 */ } } };

  // 授权屏障的另一半：子进程启动前，启动记录必须已经处在 running，且心跳刚被刷新过。
  updateRecord(recordPath, { state: 'running', heartbeatAt: stamp() });
  log('supervisor 已登记 pid=' + process.pid + '，准备启动子进程 ' + childScript);
  const argv = childArgv(resolve(childScript), childArgs);
  let child;
  try {
    child = spawn(process.execPath, argv, {
      cwd: process.cwd(),
      env: { ...process.env, BENCH_LAUNCH_RECORD: recordPath, BENCH_SUPERVISOR_TOKEN: token },
      stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeExitFact(exitPath, { code: null, signal: null, at: stamp(), descendantsVerified: true, note: '子进程启动失败：' + message, cancelled: existsSync(cancelPath) });
    updateRecord(recordPath, { childExitedAt: stamp(), exitCode: null, note: message });
    if (logFd !== null) closeSync(logFd);
    return { exitCode: 1, note: message };
  }
  const childPid = child.pid ?? null;
  const childStartedAt = childPid === null ? null : processStartTime(childPid, { cache: false });
  // descendants 是 API 侧的残留记录：这里只写下已知的直接子进程身份，是否仍在运行由 API 探测后更新。
  updateRecord(recordPath, { childPid, childStartedAt, descendants: childPid === null ? null : [{ pid: childPid, startedAt: childStartedAt, role: 'dsh-compare' }] });
  log('子进程已启动 pid=' + String(childPid));

  let cancelledAt: string | null = null;
  let stopping = false;
  const heartbeat = setInterval(() => {
    try { updateRecord(recordPath, { heartbeatAt: stamp() }); } catch { /* 心跳失败不致命，租约到期会由 API 判为 unknown */ }
  }, heartbeatMs);
  heartbeat.unref?.();
  const cancelWatch = setInterval(() => {
    if (stopping || !existsSync(cancelPath)) return;
    stopping = true;
    cancelledAt = stamp();
    log('收到取消请求，先优雅终止进程树。');
    if (childPid !== null) terminateTree(childPid, { force: false });
    setTimeout(() => {
      if (childPid !== null && isAlive(childPid)) { log('优雅终止未生效，升级为强制终止。'); terminateTree(childPid, { force: true }); }
    }, gracefulGraceMs).unref?.();
  }, cancelPollMs);
  cancelWatch.unref?.();

  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    log('supervisor 收到 ' + signal + '，回收整棵进程树。');
    if (childPid !== null) terminateTree(childPid, { force: true });
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const outcome = await new Promise<{ code: number | null; signal: string | null; error: boolean }>(resolvePromise => {
    child.on('error', error => {
      log('子进程 error 事件：' + error.message);
      resolvePromise({ code: null, signal: null, error: true });
    });
    child.on('exit', (code, signal) => resolvePromise({ code, signal, error: false }));
  });

  clearInterval(heartbeat);
  clearInterval(cancelWatch);
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);

  // 5. 退出事实：先停心跳再落盘，避免与 API 的落定写并发。
  const descendedClean = childPid === null ? false : descendantsGone(childPid);
  const note = outcome.error ? '子进程未能启动（spawn error）。' : cancelledAt === null ? null : '操作者取消：supervisor 已终止进程树（请求于 ' + cancelledAt + '）。';
  writeExitFact(exitPath, { code: outcome.code, signal: outcome.signal, at: stamp(), descendantsVerified: descendedClean, note,
    cancelled: cancelledAt !== null || existsSync(cancelPath) || (outcome.signal !== null && ['SIGTERM', 'SIGINT', 'SIGKILL', 'SIGBREAK'].includes(outcome.signal)) });
  updateRecord(recordPath, { childExitedAt: stamp(), exitCode: outcome.code });
  log('子进程退出 code=' + String(outcome.code) + ' signal=' + String(outcome.signal) + ' 后代已确认退出=' + String(descendedClean));
  if (logFd !== null) closeSync(logFd);
  return { exitCode: outcome.code ?? (outcome.error ? 1 : 0), note };
}

async function main(): Promise<void> {
  const recordPath = argumentValue(launchRecordFlag);
  if (recordPath === null) {
    process.stderr.write('用法：node --import tsx scripts/experiment-supervisor.ts --launch-record <启动记录路径>\n');
    process.exitCode = 2;
    return;
  }
  try {
    const outcome = await supervise(resolve(recordPath));
    process.exitCode = outcome.exitCode;
  } catch (error) {
    process.stderr.write('supervisor 异常退出：' + (error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = 1;
  }
}

// 被 launches.ts import 时不启动主流程：只有带 --launch-record 直接运行时才监督。
if (process.argv.includes(launchRecordFlag)) void main();
