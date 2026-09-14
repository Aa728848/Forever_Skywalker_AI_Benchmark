import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { TaskManifest } from '@fsa/contracts';
import { applyReferencePatch, declaredCheckIds, exportWorkspace, installHiddenChecks, listFiles, parseTap, readManifest, repositoryRoot, runChecks } from './index.ts';

interface Mutant {
  id: string;
  description: string;
  patch: string;
  expectedFailures: string[];
}

/** 作者维护的错误修复目录；不是候选提交可指定的命令或补丁。 */
export function readMutants(taskId: string): Mutant[] {
  const manifest = readManifest(taskId);
  const location = join(repositoryRoot, 'graders', taskId, 'mutants.json');
  if (!existsSync(location)) throw new Error(`${taskId} 尚未提供近似错误修复，不能声称已验证检出能力。`);
  const value: unknown = JSON.parse(readFileSync(location, 'utf8'));
  if (!Array.isArray(value) || value.length < 3 || value.length > 20) throw new Error('每题需要 3–20 个预声明的近似错误修复。');
  const declared = new Set(manifest.checks.map(check => check.id));
  const ids = new Set<string>();
  for (const input of value) {
    const item = input as Partial<Mutant> | null;
    if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id) || ids.has(item.id)
      || typeof item.description !== 'string' || item.description.trim() === '' || typeof item.patch !== 'string'
      || !item.patch.startsWith(`graders/${taskId}/mutants/`) || !item.patch.endsWith('.patch')
      || item.patch.split(/[\\/]/).includes('..') || !Array.isArray(item.expectedFailures) || item.expectedFailures.length === 0
      || new Set(item.expectedFailures).size !== item.expectedFailures.length || item.expectedFailures.some(id => !declared.has(id))) {
      throw new Error('错误修复声明含重复 ID、非法路径或未声明的失败检查。');
    }
    const path = realpathSync(join(repositoryRoot, item.patch));
    const scope = relative(realpathSync(join(repositoryRoot, 'graders', taskId, 'mutants')), path);
    if (isAbsolute(scope) || scope.startsWith('..')) throw new Error('错误修复补丁越过受信目录。');
    ids.add(item.id);
  }
  return value as Mutant[];
}

interface MutationPhase {
  kind: 'public' | 'hidden';
  exitCode: number | null;
  failed: string[];
  missing: string[];
  unexpected: string[];
}

/** 只有完整、正常结束的声明检查才构成检出；编译崩溃或漏跑不会提升检出率。 */
export function classifyMutation(phases: readonly MutationPhase[], expectedFailures: readonly string[]) {
  const failed = phases.flatMap(phase => phase.failed).sort();
  const valid = phases.length === 2 && phases.every(phase => phase.missing.length === 0 && phase.unexpected.length === 0
    && phase.exitCode === (phase.failed.length > 0 ? 1 : 0));
  const requiredDetected = expectedFailures.every(id => failed.includes(id));
  return { valid, detected: valid && failed.length > 0, matchesExpected: valid && requiredDetected, failed,
    additionalFailures: failed.filter(id => !expectedFailures.includes(id)) };
}

function protectedFiles(workspace: string) {
  return Object.fromEntries(listFiles(workspace).filter(path => !path.startsWith('starter/')).map(path => [path, createHash('sha256').update(readFileSync(join(workspace, path))).digest('hex')]));
}

export function verifyMutants(taskId: string, artifactDirectory: string) {
  const manifest = readManifest(taskId);
  const mutants = readMutants(taskId);
  const scratch = mkdtempSync(join(tmpdir(), 'fsa-mutants-'));
  const run = (workspace: string, label: string): MutationPhase[] => (['public', 'hidden'] as const).map(kind => {
    const result = runChecks({ workspace, command: manifest.commands[kind], timeoutMs: manifest.limits.timeoutMs, artifactDir: artifactDirectory, label: `${label}-${kind}` });
    const outcomes = parseTap(result.stdout);
    const declared = declaredCheckIds(manifest, kind);
    return { kind, exitCode: result.exitCode, failed: outcomes.filter(check => !check.ok).map(check => check.id),
      missing: declared.filter(id => !outcomes.some(check => check.id === id)), unexpected: outcomes.filter(check => !declared.includes(check.id)).map(check => check.id) };
  });
  try {
    const baseline = join(scratch, 'reference');
    exportWorkspace(taskId, baseline);
    if (applyReferencePatch(manifest, baseline, join(artifactDirectory, 'reference-patch')).exitCode !== 0) throw new Error('参考补丁无法应用。');
    installHiddenChecks(manifest, baseline);
    const baselinePhases = run(baseline, 'reference');
    const baselineResult = classifyMutation(baselinePhases, []);
    if (!baselineResult.valid || baselineResult.failed.length !== 0) throw new Error('参考实现未通过，停止错误修复验证；不计入检出率。');
    const results = mutants.map(mutant => {
      const workspace = join(scratch, mutant.id);
      exportWorkspace(taskId, workspace);
      if (applyReferencePatch(manifest, workspace, join(artifactDirectory, mutant.id, 'reference-patch')).exitCode !== 0) throw new Error('参考补丁无法应用。');
      const before = protectedFiles(workspace);
      const mutated: TaskManifest = { ...manifest, grader: { ...manifest.grader, referencePatch: mutant.patch } };
      if (applyReferencePatch(mutated, workspace, join(artifactDirectory, mutant.id, 'mutation-patch')).exitCode !== 0) throw new Error(`错误修复补丁无法应用：${mutant.id}`);
      if (JSON.stringify(before) !== JSON.stringify(protectedFiles(workspace))) throw new Error(`错误修复改动了 starter 之外的受保护文件：${mutant.id}`);
      installHiddenChecks(manifest, workspace);
      const phases = run(workspace, mutant.id);
      return { ...mutant, patchHash: createHash('sha256').update(readFileSync(join(repositoryRoot, mutant.patch))).digest('hex'), phases, ...classifyMutation(phases, mutant.expectedFailures) };
    });
    return { taskId, taskVersion: manifest.taskVersion, profile: 'local' as const, generatedAt: new Date().toISOString(), baselinePhases,
      variants: results, expected: mutants.length, detected: results.filter(item => item.detected).length,
      ok: results.every(item => item.detected && item.matchesExpected) };
  } finally {
    const target = resolve(scratch);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('fsa-mutants-')) throw new Error('错误修复工作区越界。');
    rmSync(target, { recursive: true, force: true });
  }
}
