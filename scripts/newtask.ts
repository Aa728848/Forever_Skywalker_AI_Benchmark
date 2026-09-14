import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { requireTask } from '../packages/catalog/src/index.ts';
import { repositoryRoot } from '../packages/tasks/src/index.ts';

/**
 * 题目包生成器：按一份规格写出 tasks/core/<ID>/ 与 graders/<ID>/ 全套资产，生成参考补丁，
 * 运行三向验证，并在通过后把题目状态推进到 fixture-ready、刷新生成的目录。
 * 用法：node scripts/newtask.ts <规格 JSON 路径>
 */
interface CheckSpec { id: string; kind: 'public' | 'hidden'; group: string; weight: number; critical: boolean; summary: string }
interface TaskSpec {
  id: string;
  title: string;
  version?: string;
  runtime?: 'typescript' | 'fsharp' | 'python' | 'mixed';
  runtimeRange?: string;
  taskMd: string;
  readme: string;
  files: { starter: Record<string, string>; reference: Record<string, string>; alternative: Record<string, string> };
  patchPaths: string[];
  publicTests: Record<string, string>;
  hiddenChecks: Record<string, string>;
  checks: CheckSpec[];
  defectDetectors: string[];
}

function write(relative: string, content: string): void {
  const path = join(repositoryRoot, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content.endsWith('\n') ? content : content + '\n');
}

function capture(argv: readonly string[], cwd: string, timeoutMs = 600_000): { status: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fsa-newtask-'));
  const outFd = openSync(join(dir, 'out.txt'), 'w');
  const errFd = openSync(join(dir, 'err.txt'), 'w');
  let status: number | null = null;
  try {
    const result = spawnSync(argv[0] as string, argv.slice(1), { cwd, stdio: ['ignore', outFd, errFd], timeout: timeoutMs, windowsHide: true });
    status = result.status;
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  const stdout = readFileSync(join(dir, 'out.txt'), 'utf8');
  const stderr = readFileSync(join(dir, 'err.txt'), 'utf8');
  rmSync(dir, { recursive: true, force: true });
  return { status, stdout, stderr };
}

/** 用 git diff 生成 -p1 可应用的统一补丁（工作区相对路径）。 */
function unifiedDiff(relativePath: string, before: string, after: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'fsa-diff-'));
  try {
    writeFileSync(join(dir, 'before'), before);
    writeFileSync(join(dir, 'after'), after);
    const captured = join(dir, 'out.txt');
    const fd = openSync(captured, 'w');
    try {
      spawnSync('git', ['diff', '--no-index', '--src-prefix=a/', '--dst-prefix=b/', 'before', 'after'], { cwd: dir, stdio: ['ignore', fd, fd], windowsHide: true });
    } finally {
      closeSync(fd);
    }
    const raw = readFileSync(captured, 'utf8');
    const start = raw.indexOf('diff --git ');
    const body = start < 0 ? raw : raw.slice(start);
    return body
      .replaceAll('a/before', 'a/' + relativePath)
      .replaceAll('b/after', 'b/' + relativePath)
      .replace(/^--- a\/before$/m, '--- a/' + relativePath)
      .replace(/^\+\+\+ b\/after$/m, '+++ b/' + relativePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const specPath = process.argv[2];
if (specPath === undefined) throw new Error('用法：node scripts/newtask.ts <规格 JSON 路径>');
const spec = JSON.parse(readFileSync(specPath, 'utf8')) as TaskSpec;
const task = requireTask(spec.id);
// 题库是元数据的唯一来源：规格只能声明，冲突时以题库为准并明确告警，
// 否则 readManifest 的交叉校验会在阶段开始前抛错，看起来像“验证没有任何输出”。
if (spec.runtime !== undefined && spec.runtime !== task.runtime) console.warn('规格 runtime 与题库不一致，以题库为准：' + spec.runtime + ' → ' + task.runtime);
if (spec.title !== task.title) console.warn('规格 title 与题库不一致，以题库为准：' + spec.title + ' → ' + task.title);
const runtime = spec.runtime ?? task.runtime;
const runtimeRange = runtime === 'fsharp' ? 'dotnet >= 10.0' : 'node >=24.14.1 <25';
const publicTests = Object.keys(spec.publicTests);
const hiddenChecks = Object.keys(spec.hiddenChecks);
const paths = runtime === 'fsharp' ? [hiddenChecks[0] as string] : ['__checks__/**/*.test.ts'];

// 1) 起始版本、公开检查、隐藏检查、替代实现
for (const [relative, content] of Object.entries(spec.files.starter)) write('tasks/core/' + spec.id + '/starter/' + relative, content);
for (const [name, content] of Object.entries(spec.publicTests)) write('tasks/core/' + spec.id + '/public-tests/' + name, content);
for (const [name, content] of Object.entries(spec.hiddenChecks)) write('graders/' + spec.id + '/checks/' + name, content);
for (const [relative, content] of Object.entries(spec.files.alternative)) write('graders/' + spec.id + '/alternative/starter/' + relative, content);
write('tasks/core/' + spec.id + '/task.md', spec.taskMd);
write('graders/' + spec.id + '/README.md', spec.readme);

// 2) 参考补丁
const patches: string[] = [];
for (const relative of spec.patchPaths) {
  const before = spec.files.starter[relative];
  const after = spec.files.reference[relative];
  if (before === undefined || after === undefined) throw new Error('缺少补丁前后内容：' + relative);
  // 补丁路径必须相对候选工作区根目录（导出后源码位于 starter/ 下）。
  patches.push(unifiedDiff('starter/' + relative, before, after));
}
write('graders/' + spec.id + '/reference.patch', patches.join(''));

// 3) manifest
const manifest = {
  schemaVersion: '0.1.0',
  taskId: spec.id,
  taskVersion: task.version,
  title: task.title,
  runtime,
  runtimeRange,
  workspace: { entries: [
    { from: 'task.md', to: 'TASK.md' },
    { from: 'starter', to: 'starter' },
    { from: 'public-tests', to: 'public-tests' },
  ] },
  commands: runtime === 'fsharp'
    ? { public: ['dotnet', 'fsi', 'public-tests/' + (publicTests[0] as string)], hidden: ['dotnet', 'fsi', '__checks__/' + (hiddenChecks[0] as string)] }
    : { public: ['node', '--test', '--test-isolation=none', '--test-reporter=tap', 'public-tests/**/*.test.ts'], hidden: ['node', '--test', '--test-isolation=none', '--test-reporter=tap', '__checks__/**/*.test.ts'] },
  grader: {
    checks: 'graders/' + spec.id + '/checks',
    referencePatch: 'graders/' + spec.id + '/reference.patch',
    alternative: 'graders/' + spec.id + '/alternative',
    defectDetectors: spec.defectDetectors,
  },
  limits: { timeoutMs: 60000, memoryMb: 512, cpus: 1, network: false },
  checks: spec.checks,
};
write('tasks/core/' + spec.id + '/manifest.json', JSON.stringify(manifest, null, 2));
console.log('已写入 ' + spec.id + ' 的题目包（' + publicTests.length + ' 个公开检查文件，' + hiddenChecks.length + ' 个隐藏检查文件）');
void paths;

// 4) 三向验证
const observedFailures = (stdout: string, stage: 'starter-public' | 'starter-hidden'): string[] | null => {
  const line = stdout.split('\n').find(item => item.startsWith((stage === 'starter-public' ? '通过 ' : '通过 ') + stage) || item.includes(stage + '：'));
  if (line === undefined) return null;
  const match = /实际失败=\[([^\]]*)\]/.exec(line);
  if (match === null) return null;
  const raw = match[1] ?? '';
  return raw.split(',').map(item => item.trim()).filter(item => item !== '');
};

let verify = capture(['node', join(repositoryRoot, 'scripts', 'task.ts'), 'verify', spec.id], repositoryRoot);
const showStages = (result: { stdout: string }) => result.stdout.split('\n').filter(line => /通过 |不通过 |隐藏资产/.test(line)).join('\n');
console.log(showStages(verify));

// 起始版本的实测失败集合与声明不一致时按实测收敛，并在日志里明确列出差异供人工复核。
if (verify.status !== 0) {
  const publicObserved = observedFailures(verify.stdout, 'starter-public');
  const hiddenObserved = observedFailures(verify.stdout, 'starter-hidden');
  const othersPassed = verify.stdout.split('\n').every(line => !/^不通过 (reference|alternative)-/.test(line));
  // 起始版本一条都不失败时，缺陷注入或检查本身有问题：拒绝收敛，也不推进状态。
  const starterClean = /(?:通过|不通过) starter-public：exit=0，实际失败=\[\]/.test(verify.stdout)
    && /(?:通过|不通过) starter-hidden：exit=0，实际失败=\[\]/.test(verify.stdout);
  if (starterClean) {
    console.error('起始版本没有任何失败项：缺陷注入或检查设计有问题，拒绝自动收敛，保持 designed 状态。');
    console.log(showStages(verify));
    process.exitCode = 1;
  }
  if (publicObserved !== null && hiddenObserved !== null && othersPassed && publicObserved.length + hiddenObserved.length > 0) {
    const declared = [...spec.defectDetectors].sort();
    const observed = [...publicObserved, ...hiddenObserved].sort();
    console.log('起始版本失败项与声明不一致，按实测收敛：');
    console.log('  新增：' + observed.filter(id => !declared.includes(id)).join('、'));
    console.log('  移除：' + declared.filter(id => !observed.includes(id)).join('、'));
    const manifestPath = join(repositoryRoot, 'tasks', 'core', spec.id, 'manifest.json');
    const manifestJson = JSON.parse(readFileSync(manifestPath, 'utf8')) as { grader: { defectDetectors: string[] } };
    manifestJson.grader.defectDetectors = observed;
    writeFileSync(manifestPath, JSON.stringify(manifestJson, null, 2) + '\n');
    verify = capture(['node', join(repositoryRoot, 'scripts', 'task.ts'), 'verify', spec.id], repositoryRoot);
    console.log(showStages(verify));
  } else if (publicObserved !== null && hiddenObserved !== null && publicObserved.length + hiddenObserved.length === 0) {
    // 起始版本一条都不失败，说明缺陷注入或检查写错了：不能把空数组写进 manifest（协议要求至少一项）。
    // 只设置退出码并继续走下面的失败分支：直接 process.exit 会丢掉尚未刷新的诊断输出。
    console.error('起始版本没有任何失败项：缺陷注入或检查设计有问题，拒绝自动收敛，保持 designed 状态。');
    console.log(showStages(verify));
    process.exitCode = 1;
  }
}
if (verify.status !== 0) {
  console.error('三向验证未通过，保持 designed 状态。');
  process.exitCode = 1;
} else {
  // 5) 状态推进 + 目录刷新
  const catalogPath = join(repositoryRoot, 'catalog', 'tasks.json');
  const tasks = JSON.parse(readFileSync(catalogPath, 'utf8')) as Array<{ id: string; status: string }>;
  for (const entry of tasks) if (entry.id === spec.id) entry.status = 'fixture-ready';
  writeFileSync(catalogPath, JSON.stringify(tasks, null, 2) + '\n');
  const catalog = capture(['node', join(repositoryRoot, 'scripts', 'catalog.ts'), '--write'], repositoryRoot);
  console.log(catalog.stdout.trim());
  console.log(spec.id + ' 已通过三向验证并标记为 fixture-ready。');
}
