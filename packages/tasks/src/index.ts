import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, closeSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireTask } from '@fsa/catalog';
import { taskManifestValidator, type TaskManifest } from '@fsa/contracts';

/**
 * 题目包支撑层：manifest 校验、候选工作区白名单导出、受信检查执行与三向验证。
 * 隐藏资产（graders/**）由本模块的调用方在导出之后单独注入，不经过导出白名单。
 */
export const repositoryRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));

const excludedNames = new Set(['node_modules', '.git']);
const hiddenDirectoryName = '__checks__';

function isInside(parent: string, child: string): boolean {
  const scope = relative(parent, child);
  return scope === '' || (!scope.startsWith('..') && !isAbsolute(scope));
}

function assertRelative(value: string, label: string): void {
  if (isAbsolute(value)) throw new Error(`${label} 必须是相对路径：${value}`);
  if (value.split(/[\\/]+/).includes('..')) throw new Error(`${label} 不得包含上级目录：${value}`);
}

function copyTree(source: string, target: string, root: string, files: string[]): void {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`不得复制符号链接：${source}`);
  if (stat.isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const child of readdirSync(source).sort()) {
      if (excludedNames.has(child)) throw new Error(`题目包不得包含 ${child}：${source}`);
      copyTree(join(source, child), join(target, child), root, files);
    }
    return;
  }
  if (!stat.isFile()) throw new Error(`不支持的复制类型：${source}`);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  files.push(relative(root, target).split(sep).join('/'));
}

/** 题目包在仓库中的固定位置，由题库 track 决定目录。 */
export function taskPackageDir(taskId: string): string {
  const task = requireTask(taskId);
  return join(repositoryRoot, 'tasks', task.track === 'core' ? 'core' : 'integration', taskId);
}

/** 读取并校验题目包 manifest，同时核对题库元数据与隐藏资产位置。 */
export function readManifest(taskId: string): TaskManifest {
  const directory = taskPackageDir(taskId);
  const manifestPath = join(directory, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`题目包缺少 manifest.json：${taskId}`);
  const input: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!taskManifestValidator.Check(input)) throw new Error(`题目包 manifest 不符合 0.1.0 协议：${taskId}`);
  const manifest = input;
  const task = requireTask(taskId);
  if (manifest.taskId !== taskId) throw new Error(`manifest.taskId 与题目包目录不一致：${manifest.taskId}`);
  if (manifest.taskVersion !== task.version) throw new Error(`manifest.taskVersion 与题库不一致：${manifest.taskVersion}`);
  if (manifest.runtime !== task.runtime) throw new Error(`manifest.runtime 与题库不一致：${manifest.runtime}`);
  if (manifest.title !== task.title) throw new Error(`manifest.title 与题库不一致：${manifest.title}`);

  const ids = manifest.checks.map(check => check.id);
  if (new Set(ids).size !== ids.length) throw new Error('检查 ID 重复。');
  if (!manifest.checks.some(check => check.critical)) throw new Error('题目包必须声明至少一个关键验收项。');
  for (const detector of manifest.grader.defectDetectors) {
    if (!ids.includes(detector)) throw new Error(`缺陷检出项不在检查清单中：${detector}`);
  }

  for (const path of [manifest.grader.checks, manifest.grader.referencePatch, manifest.grader.alternative]) {
    assertRelative(path, 'grader 路径');
    const absolute = join(repositoryRoot, path);
    if (isInside(directory, absolute)) throw new Error(`隐藏资产必须位于题目包之外：${path}`);
    if (!existsSync(absolute)) throw new Error(`隐藏资产不存在：${path}`);
  }
  for (const entry of manifest.workspace.entries) {
    assertRelative(entry.from, 'workspace.entries.from');
    assertRelative(entry.to, 'workspace.entries.to');
    const source = join(directory, entry.from);
    if (!isInside(directory, source) || source === directory) throw new Error(`导出项必须位于题目包内：${entry.from}`);
    if (!existsSync(source)) throw new Error(`导出项不存在：${entry.from}`);
  }
  return manifest;
}

export interface ExportRecord {
  taskId: string;
  destination: string;
  files: string[];
}

/** 按 manifest 白名单导出候选工作区；未列出的资产一律不复制。 */
export function exportWorkspace(taskId: string, destination: string): ExportRecord {
  const manifest = readManifest(taskId);
  const directory = taskPackageDir(taskId);
  const target = resolve(destination);
  if (target === repositoryRoot) throw new Error('导出目标不得是仓库根目录。');
  if (isInside(target, repositoryRoot)) throw new Error('导出目标不得是仓库的上级目录。');
  if (isInside(directory, target)) throw new Error('导出目标不得位于题目包内。');
  if (existsSync(target)) {
    if (!statSync(target).isDirectory()) throw new Error(`导出目标必须是目录：${target}`);
    if (readdirSync(target).length > 0) throw new Error(`导出目标必须为空：${target}`);
  } else {
    mkdirSync(target, { recursive: true });
  }
  const files: string[] = [];
  for (const entry of manifest.workspace.entries) {
    copyTree(join(directory, entry.from), join(target, entry.to), target, files);
  }
  files.sort();
  return { taskId, destination: target, files };
}

/** 列出目录下的全部普通文件（相对路径，正斜杠）。 */
export function listFiles(directory: string): string[] {
  const files: string[] = [];
  const walk = (current: string) => {
    for (const child of readdirSync(current).sort()) {
      const absolute = join(current, child);
      if (lstatSync(absolute).isDirectory()) walk(absolute);
      else files.push(relative(directory, absolute).split(sep).join('/'));
    }
  };
  walk(directory);
  return files;
}

/** 把隐藏检查注入工作区，返回注入的相对路径。注入仅由受信侧调用，不进入导出白名单。 */
export function installHiddenChecks(manifest: TaskManifest, workspace: string): string[] {
  const files: string[] = [];
  const target = join(workspace, hiddenDirectoryName);
  copyTree(join(repositoryRoot, manifest.grader.checks), target, workspace, files);
  files.sort();
  return files;
}

/** 用替代实现覆盖工作区，用于证明检查未绑定某一种代码结构。 */
export function installAlternative(manifest: TaskManifest, workspace: string): string[] {
  const files: string[] = [];
  copyTree(join(repositoryRoot, manifest.grader.alternative), workspace, workspace, files);
  files.sort();
  return files;
}

export interface CommandResult {
  command: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runCommand(command: readonly string[], cwd: string, artifactDir: string, label: string, timeoutMs: number): CommandResult {
  const [executable = 'node', ...args] = command;
  const resolved = executable === 'node' ? process.execPath : executable;
  mkdirSync(artifactDir, { recursive: true });
  const stdoutPath = join(artifactDir, `${label}.stdout.txt`);
  const stderrPath = join(artifactDir, `${label}.stderr.txt`);
  const stdoutFd = openSync(stdoutPath, 'w');
  const stderrFd = openSync(stderrPath, 'w');
  let result;
  try {
    // 使用文件描述符而不是管道：受限沙盒会拒绝命名管道，且原始输出需要留存为证据。
    result = spawnSync(resolved, args, { cwd, stdio: ['ignore', stdoutFd, stderrFd], timeout: timeoutMs, windowsHide: true });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  return {
    command: [executable, ...args],
    exitCode: result.status,
    stdout: readFileSync(stdoutPath, 'utf8'),
    stderr: readFileSync(stderrPath, 'utf8'),
  };
}

/** 应用参考补丁；补丁路径相对工作区根目录。 */
export function applyReferencePatch(manifest: TaskManifest, workspace: string, artifactDir: string): CommandResult {
  const patch = join(repositoryRoot, manifest.grader.referencePatch);
  return runCommand(['git', 'apply', '--whitespace=nowarn', patch], workspace, artifactDir, 'patch', manifest.limits.timeoutMs);
}

export interface CheckOutcome {
  id: string;
  ok: boolean;
  skipped: boolean;
  durationMs: number | null;
}

/** 解析 node --test 的 TAP 输出，测试名即检查 ID；duration_ms 从测试行后的诊断块读取。 */
export function parseTap(output: string): CheckOutcome[] {
  const lines = output.split(/\r?\n/);
  const outcomes: CheckOutcome[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(not ok|ok) (\d+) - (.+)$/.exec(lines[index] ?? '');
    if (!match) continue;
    const status = match[1] ?? '';
    const raw = match[3] ?? '';
    const skipped = / # (?:SKIP|TODO)\b/i.test(raw);
    let durationMs: number | null = null;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? '';
      const found = /^\s+duration_ms:\s*([0-9.]+)/.exec(line);
      if (found !== null) {
        durationMs = Number(found[1]);
        break;
      }
      if (/^\S/.test(line)) break;
    }
    outcomes.push({
      id: raw.replace(/ # (?:SKIP|TODO)\b.*$/i, '').trim(),
      ok: status === 'ok' && !skipped,
      skipped,
      durationMs,
    });
  }
  return outcomes;
}

export type CheckKind = 'public' | 'hidden';

export function declaredCheckIds(manifest: TaskManifest, kind: CheckKind): string[] {
  return manifest.checks.filter(check => check.kind === kind).map(check => check.id);
}

export function missingCheckIds(expected: readonly string[], outcomes: readonly CheckOutcome[]): string[] {
  const seen = new Set(outcomes.map(outcome => outcome.id));
  return expected.filter(id => !seen.has(id));
}

export function failedCheckIds(outcomes: readonly CheckOutcome[]): string[] {
  return outcomes.filter(outcome => !outcome.ok).map(outcome => outcome.id);
}

export interface CheckRun extends CommandResult {
  workspace: string;
  timedOut: boolean;
  durationMs: number;
}

/** 在工作区内执行固定检查命令，原始输出写入产物目录。 */
export function runChecks(options: { label: string; workspace: string; command: readonly string[]; timeoutMs: number; artifactDir: string }): CheckRun {
  const startedAt = process.hrtime.bigint();
  const result = runCommand(options.command, options.workspace, options.artifactDir, options.label, options.timeoutMs);
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  return {
    ...result,
    workspace: options.workspace,
    timedOut: result.exitCode === null,
    durationMs: Math.round(durationMs),
  };
}

export type Variant = 'starter' | 'reference' | 'alternative';

export interface PhaseEvidence {
  name: string;
  variant: Variant;
  kind: CheckKind;
  command: string[];
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  outcomes: CheckOutcome[];
  expectedFailed: string[];
  actualFailed: string[];
  missing: string[];
  ok: boolean;
}

export interface VerificationReport {
  schemaVersion: '0.1.0';
  taskId: string;
  taskVersion: string;
  startedAt: string;
  finishedAt: string;
  files: string[];
  hiddenAssetsExcluded: boolean;
  phases: PhaseEvidence[];
  ok: boolean;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every(value => right.includes(value));
}

export interface VerifyOptions {
  taskId: string;
  artifactDir: string;
  keepWorkspace?: boolean;
}

/**
 * 三向验证：缺陷起始版本只被声明的检出项判失败，参考补丁与替代实现必须全部通过，
 * 且导出工作区不得包含任何隐藏资产。
 */
export function verifyTaskPackage(options: VerifyOptions): VerificationReport {
  const manifest = readManifest(options.taskId);
  const startedAt = new Date().toISOString();
  const workspaceRoot = mkdtempSync(join(tmpdir(), `fsa-${options.taskId.toLowerCase()}-`));
  const phases: PhaseEvidence[] = [];
  let files: string[] = [];
  let hiddenAssetsExcluded = false;
  const publicDetectors = manifest.grader.defectDetectors.filter(id => declaredCheckIds(manifest, 'public').includes(id));
  const hiddenDetectors = manifest.grader.defectDetectors.filter(id => declaredCheckIds(manifest, 'hidden').includes(id));

  const prepare = (variant: Variant): string => {
    const workspace = join(workspaceRoot, variant);
    const record = exportWorkspace(options.taskId, workspace);
    files = record.files;
    if (variant === 'starter') {
      // 注入隐藏检查之前观察导出结果：白名单之外的资产不得出现在候选工作区。
      const observed = listFiles(workspace);
      hiddenAssetsExcluded = observed.length === record.files.length && !observed.some(file =>
        file.includes('__checks__') || file.includes('reference.patch') || file.startsWith('graders/'));
    }
    if (variant === 'reference') {
      const patched = applyReferencePatch(manifest, workspace, join(options.artifactDir, 'raw'));
      if (patched.exitCode !== 0) throw new Error(`参考补丁应用失败：${patched.stderr.trim()}`);
    }
    if (variant === 'alternative') installAlternative(manifest, workspace);
    installHiddenChecks(manifest, workspace);
    return workspace;
  };

  const runPhase = (variant: Variant, kind: CheckKind, workspace: string): void => {
    const detected = kind === 'public' ? publicDetectors : hiddenDetectors;
    // 未修复的起始版本只应在声明的检出项上失败；参考补丁与替代实现必须全部通过。
    const expectedFailed = (variant === 'starter' ? detected : []).slice().sort();
    const run = runChecks({
      label: `${options.taskId}-${variant}-${kind}`,
      workspace,
      command: manifest.commands[kind],
      timeoutMs: manifest.limits.timeoutMs,
      artifactDir: join(options.artifactDir, 'raw'),
    });
    const outcomes = parseTap(run.stdout);
    const actualFailed = failedCheckIds(outcomes).sort();
    const missing = missingCheckIds(declaredCheckIds(manifest, kind), outcomes);
    phases.push({
      name: `${variant}-${kind}`,
      variant,
      kind,
      command: run.command,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      durationMs: run.durationMs,
      outcomes,
      expectedFailed,
      actualFailed,
      missing,
      ok: !run.timedOut && missing.length === 0 && sameSet(actualFailed, expectedFailed),
    });
  };

  try {
    for (const variant of ['starter', 'reference', 'alternative'] as const) {
      const workspace = prepare(variant);
      runPhase(variant, 'public', workspace);
      runPhase(variant, 'hidden', workspace);
    }
  } finally {
    if (!options.keepWorkspace) rmSync(workspaceRoot, { recursive: true, force: true });
  }

  return {
    schemaVersion: '0.1.0',
    taskId: options.taskId,
    taskVersion: manifest.taskVersion,
    startedAt,
    finishedAt: new Date().toISOString(),
    files,
    hiddenAssetsExcluded,
    phases,
    ok: hiddenAssetsExcluded && phases.every(phase => phase.ok),
  };
}
