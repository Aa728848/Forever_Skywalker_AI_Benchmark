import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionResult } from '../packages/contracts/src/index.ts';
import { requireTask } from '../packages/catalog/src/index.ts';
import { applyReferencePatch, exportWorkspace, readManifest, repositoryRoot } from '../packages/tasks/src/index.ts';
import { createEnvelope, createRunStore } from '../packages/runs/src/index.ts';
import { readExecutionScore, verifySubmission } from '../packages/executor/src/index.ts';

/** M1-06 试点试跑：8 道题各自跑一次缺陷候选与一次参考补丁候选，记录可执行状态与原始证据。 */
const pilots = ['FE-01', 'LSP-01', 'CACHE-02', 'BND-02', 'THR-03', 'GRAPH-03', 'CONC-04', 'PERF-04'];

interface VariantReport {
  variant: 'defect' | 'reference';
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
}

interface TaskReport {
  taskId: string;
  title: string;
  difficulty: string;
  runtime: string;
  phases: VariantReport[];
  ok: boolean;
  note: string;
}

function taskIdOf(result: ExecutionResult): string {
  return result.taskId;
}

function summarize(variant: VariantReport['variant'], expected: string[], result: ExecutionResult, reused: boolean, patchApplied: boolean): VariantReport {
  const failed = result.checks.filter(check => check.status === 'failed').map(check => check.id).sort();
  const missing = result.checks.filter(check => check.status === 'not-run').map(check => check.id).sort();
  const declared = [...expected].sort();
  const score = readExecutionScore(join(artifactRoot, 'runs', taskIdOf(result), result.runId, result.attemptId));
  return {
    variant,
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
    taskId, title: manifest.title, difficulty: catalogTask.difficulty, runtime: manifest.runtime,
    phases: [], ok: false, note: '',
  };
  const scratch = mkdtempSync(join(tmpdir(), `fsa-trial-${taskId.toLowerCase()}-`));
  try {
    for (const variant of ['defect', 'reference'] as const) {
      const candidate = join(scratch, variant);
      exportWorkspace(taskId, candidate);
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
      report.phases.push(summarize(variant, manifest.grader.defectDetectors, outcome.execution, outcome.reusedExecution, patchApplied));
    }
    const defect = report.phases.find(phase => phase.variant === 'defect');
    const reference = report.phases.find(phase => phase.variant === 'reference');
    const referencePassed = reference?.classification === 'passed';
    const defectBlocked = defect !== undefined && defect.classification !== 'passed';
    report.ok = referencePassed && defectBlocked && (defect?.matchesDeclaredDetectors ?? false);
    report.note = [
      referencePassed ? '' : '参考补丁未全部通过',
      defectBlocked ? '' : '缺陷候选未被拦住',
      defect?.matchesDeclaredDetectors ? '' : '缺陷失败项与声明的检出项不一致',
    ].filter(Boolean).join('；');
  } catch (error) {
    report.note = error instanceof Error ? error.message : String(error);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  reports.push(report);
  const defectPhase = report.phases.find(phase => phase.variant === 'defect');
  const referencePhase = report.phases.find(phase => phase.variant === 'reference');
  const defect = defectPhase?.classification ?? '-';
  const reference = referencePhase?.classification ?? '-';
  console.log(`${report.ok ? '通过' : '不通过'} ${taskId}：缺陷=${defect}（可用验证 ${defectPhase?.functional ?? '未取得'}/50），参考=${reference}（可用验证 ${referencePhase?.functional ?? '未取得'}/50）${report.note === '' ? '' : `（${report.note}）`}`);
}

const okCount = reports.filter(report => report.ok).length;
writeFileSync(join(artifactRoot, 'report.json'), `${JSON.stringify({
  schemaVersion: '0.1.0',
  generatedAt: new Date().toISOString(),
  profile,
  isolation: profile === 'linux-container' ? 'container' : 'none',
  image,
  imageDigest,
  tasks: reports,
}, null, 2)}\n`);
console.log(`\n试跑汇总：${okCount}/${reports.length} 道题满足"参考通过且缺陷被拦住"。`);
console.log(`原始记录：${artifactRoot}`);
if (okCount !== reports.length) process.exitCode = 1;
