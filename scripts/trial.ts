import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { ExecutionResult } from '../packages/contracts/src/index.ts';
import { requireTask, tasks } from '../packages/catalog/src/index.ts';
import { applyReferencePatch, exportWorkspace, installAlternative, readManifest, repositoryRoot } from '../packages/tasks/src/index.ts';
import { createEnvelope, createRunStore } from '../packages/runs/src/index.ts';
import { readExecutionScore, verifySubmission } from '../packages/executor/src/index.ts';

/** 受控试跑：默认8道试点，可显式选择或覆盖全题库；同时验收缺陷、参考和完整功能分。 */
const args = parseArgs({ options: { all: { type: 'boolean' }, alternatives: { type: 'boolean' }, task: { type: 'string', multiple: true } } });
if (args.values.all && args.values.task?.length) throw new Error('--all 与 --task 不能同时指定。');
const pilots = args.values.all ? tasks.filter(task => task.status !== 'designed').map(task => task.id)
  : args.values.task ?? ['FE-01', 'LSP-01', 'CACHE-02', 'BND-02', 'THR-03', 'GRAPH-03', 'CONC-04', 'PERF-04'];
if (pilots.length === 0 || new Set(pilots).size !== pilots.length) throw new Error('试跑题目不能为空或重复。');

interface VariantReport {
  variant: 'defect' | 'reference' | 'alternative';
  classification: string;
  functional: number | null;
  quality: number | null;
  total: number | null;
  criticalPassed: boolean | null;
  failed: string[];
  missing: string[];
  expectedDetectors: string[];
  matchesDeclaredDetectors: boolean;
  durationMs: number;
  phaseDurations: number[];
  peakRssBytes: number[];
  reusedExecution: boolean;
  referencePatchApplied: boolean;
  error: string | null;
  isolation?: string;
  runId?: string;
  attemptId?: string;
  candidateTreeHash?: string;
}

interface TaskReport {
  taskId: string;
  taskVersion: string;
  title: string;
  difficulty: string;
  runtime: string;
  phases: VariantReport[];
  ok: boolean;
  note: string;
}

function summarize(variant: VariantReport['variant'], expected: string[], result: ExecutionResult, reused: boolean, patchApplied: boolean, attemptDirectory: string): VariantReport {
  const failed = result.checks.filter(check => check.status === 'failed').map(check => check.id).sort();
  const missing = result.checks.filter(check => check.status === 'not-run').map(check => check.id).sort();
  const declared = [...expected].sort();
  const score = readExecutionScore(attemptDirectory);
  return {
    variant,
    runId: result.runId,
    attemptId: result.attemptId,
    candidateTreeHash: result.candidateTreeHash,
    classification: result.classification,
    functional: score?.functional ?? null,
    quality: score?.quality ?? null,
    total: score?.total ?? null,
    criticalPassed: score?.criticalPassed ?? null,
    failed,
    missing,
    expectedDetectors: declared,
    matchesDeclaredDetectors: failed.length === declared.length && failed.every(id => declared.includes(id)),
    durationMs: result.durationMs,
    phaseDurations: result.phases.map(phase => phase.durationMs),
    peakRssBytes: result.phases.map(phase => phase.resource.peakRssBytes ?? 0),
    reusedExecution: reused,
    referencePatchApplied: patchApplied,
    error: null,
    isolation: result.isolation,
  };
}

// 试跑档案与正式执行一致：设 BENCH_PROFILE=linux-container 时走容器档案（需要固定的镜像与 digest）。
const profile = process.env.BENCH_PROFILE === 'linux-container' ? ('linux-container' as const) : ('local' as const);
const image = process.env.BENCH_IMAGE ?? null;
const imageDigest = process.env.BENCH_IMAGE_DIGEST ?? null;
if (profile === 'linux-container' && (image === null || imageDigest === null)) {
  throw new Error('容器档案试跑必须同时给出 BENCH_IMAGE 与 BENCH_IMAGE_DIGEST。');
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const artifactRoot = join(repositoryRoot, 'data', 'trials', stamp);
mkdirSync(artifactRoot, { recursive: true });
const store = createRunStore(join(artifactRoot, 'runs'));
const reports: TaskReport[] = [];

for (const taskId of pilots) {
  const manifest = readManifest(taskId);
  const catalogTask = requireTask(taskId);
  const report: TaskReport = {
    taskId, taskVersion: manifest.taskVersion, title: manifest.title, difficulty: catalogTask.difficulty, runtime: manifest.runtime,
    phases: [], ok: false, note: '',
  };
  const scratch = mkdtempSync(join(tmpdir(), `fsa-trial-${taskId.toLowerCase()}-`));
  try {
    const variants: VariantReport['variant'][] = args.values.alternatives ? ['defect', 'reference', 'alternative'] : ['defect', 'reference'];
    for (const variant of variants) {
      const candidate = join(scratch, variant);
      exportWorkspace(taskId, candidate);
      if (variant === 'alternative') installAlternative(manifest, candidate);
      let patchApplied = false;
      if (variant === 'reference') {
        const applied = applyReferencePatch(manifest, candidate, join(artifactRoot, 'raw'));
        patchApplied = applied.exitCode === 0;
        if (!patchApplied) {
          report.phases.push({
            variant, classification: 'patch-failed', functional: null, quality: null, total: null, criticalPassed: null,
            failed: [], missing: [], expectedDetectors: [],
            matchesDeclaredDetectors: false, durationMs: 0, phaseDurations: [], peakRssBytes: [],
            reusedExecution: false, referencePatchApplied: false, error: applied.stderr.trim() || '参考补丁应用失败',
          });
          continue;
        }
      }
      const envelope = createEnvelope(taskId, candidate, { idempotencyKey: `trial-${taskId}-${variant}-${stamp}` });
      const outcome = await verifySubmission({
        store, taskId, envelope, candidateDirectory: candidate, submittedBy: 'trial', profile, image, imageDigest,
      });
      report.phases.push(summarize(variant, manifest.grader.defectDetectors, outcome.execution, outcome.reusedExecution, patchApplied, outcome.submission.directory));
    }
    const defect = report.phases.find(phase => phase.variant === 'defect');
    const reference = report.phases.find(phase => phase.variant === 'reference');
    const alternative = report.phases.find(phase => phase.variant === 'alternative');
    const referencePassed = reference?.classification === 'passed' && reference.functional === 50 && reference.criticalPassed === true;
    const alternativePassed = !args.values.alternatives || (alternative?.classification === 'passed' && alternative.functional === 50 && alternative.criticalPassed === true);
    const defectBlocked = defect !== undefined && defect.classification === 'check-failed' && defect.functional !== null;
    report.ok = referencePassed && alternativePassed && defectBlocked && (defect?.matchesDeclaredDetectors ?? false);
    report.note = [
      referencePassed ? '' : '参考补丁未全部通过或缺少完整的 50/50 可用验证分',
      alternativePassed ? '' : '替代实现未全部通过或缺少完整的 50/50 可用验证分',
      defectBlocked ? '' : '缺陷候选未被拦住',
      defect?.matchesDeclaredDetectors ? '' : '缺陷失败项与声明的检出项不一致',
    ].filter(Boolean).join('；');
  } catch (error) {
    report.note = error instanceof Error ? error.message : String(error);
  } finally {
    const target = resolve(scratch);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('fsa-trial-')) throw new Error('试跑临时目录越界。');
    rmSync(target, { recursive: true, force: true });
  }
  reports.push(report);
  const defectPhase = report.phases.find(phase => phase.variant === 'defect');
  const referencePhase = report.phases.find(phase => phase.variant === 'reference');
  const defect = defectPhase?.classification ?? '-';
  const reference = referencePhase?.classification ?? '-';
  const alternativePhase = report.phases.find(phase => phase.variant === 'alternative');
  const alternativeText = args.values.alternatives ? `，替代=${alternativePhase?.classification ?? '-'}（可用验证 ${alternativePhase?.functional ?? '未取得'}/50）` : '';
  console.log(`${report.ok ? '通过' : '不通过'} ${taskId}：缺陷=${defect}（可用验证 ${defectPhase?.functional ?? '未取得'}/50），参考=${reference}（可用验证 ${referencePhase?.functional ?? '未取得'}/50）${alternativeText}${report.note === '' ? '' : `（${report.note}）`}`);
}

const okCount = reports.filter(report => report.ok).length;
writeFileSync(join(artifactRoot, 'report.json'), `${JSON.stringify({
  schemaVersion: '0.1.0',
  generatedAt: new Date().toISOString(),
  profile,
  isolation: reports.flatMap(report => report.phases).length === 0 ? 'not-run'
    : [...new Set(reports.flatMap(report => report.phases.map(phase => phase.isolation ?? 'not-run')))].join(','),
  image,
  imageDigest,
  tasks: reports,
}, null, 2)}\n`);
console.log(`\n试跑汇总：${okCount}/${reports.length} 道题满足"参考通过且缺陷被拦住"。`);
console.log(`原始记录：${artifactRoot}`);
if (okCount !== reports.length) process.exitCode = 1;
