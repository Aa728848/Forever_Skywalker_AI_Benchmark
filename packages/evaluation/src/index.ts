import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { requireTask } from '@fsa/catalog';
import { reviewVerdictValidator, type ExecutionArtifact, type ReviewVerdict } from '@fsa/contracts';
import { scoreExecution, type QualityEvidence } from '@fsa/core';
import type { QualityProvider } from '@fsa/executor';
import { compareReviews, createEnvironmentJudge, JudgeUnavailableError, type JudgeAdapter, type ReviewMaterial } from '@fsa/judge';
import { analyzeWorkspace, defaultPolicy } from '@fsa/static';
import { listFiles, taskPackageDir } from '@fsa/tasks';
import { measureVerificationCost } from './benchmark.ts';
export { inspectRunSelection, summarizeRuns } from './suite.ts';

export interface EvaluationOptions {
  judge?: JudgeAdapter;
  env?: NodeJS.ProcessEnv;
  measurePerformance?: boolean;
  humanReview?: { reviewer: string; reason: string; verdict: ReviewVerdict };
}

/** 真实质量评估的 I/O 组合层；未取得的证据保持缺失，评分器继续只做纯计算。 */
export function createQualityProvider(options: EvaluationOptions = {}): QualityProvider {
  return async context => {
    context.signal?.throwIfAborted();
    const artifacts: ExecutionArtifact[] = [];
    const notes: string[] = [];
    const objective: NonNullable<QualityEvidence['objective']> = {};
    let review: QualityEvidence['review'];
    let rehearsal = false;
    let benchmarkCalibrated = false;
    const materials: ReviewMaterial[] = [];
    const env = options.env ?? process.env;
    const writeEvidence = (id: string, filename: string, value: unknown) => {
      const text = JSON.stringify(value, null, 2) + '\n';
      writeFileSync(join(context.artifactDirectory, filename), text);
      artifacts.push({ id, path: filename, sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) });
      materials.push({ id, kind: 'evidence', text });
    };
    const task = context.manifest.task;
    materials.push({ id: 'task-contract', kind: 'task', text: readFileSync(join(taskPackageDir(task.taskId), 'task.md'), 'utf8') });
    materials.push({ id: 'execution-evidence', kind: 'evidence', text: JSON.stringify(context.execution) });
    const sourceFiles = listFiles(context.frozenDirectory).filter(path => path.startsWith('starter/') && /\.(?:[cm]?[jt]sx?|fsx?|py)$/.test(path));
    const changedFiles: string[] = [];
    const sources = sourceFiles.map((path, index) => {
      const text = readFileSync(join(context.frozenDirectory, path), 'utf8');
      const baselinePath = join(taskPackageDir(task.taskId), path);
      const baseline = existsSync(baselinePath) ? readFileSync(baselinePath, 'utf8') : '';
      if (baseline !== text) changedFiles.push(path);
      return { path, index, text, baseline };
    });
    if (sourceFiles.length === 0) throw new Error('冻结快照没有可评审源码。');
    const contextPaths = new Set<string>();
    const policyPath = join(taskPackageDir(task.taskId), 'static-policy.json');
    try {
      const language = sourceFiles.every(path => extname(path) === '.py') ? 'python' : sourceFiles.every(path => ['.fs', '.fsx'].includes(extname(path))) ? 'fsharp' : 'typescript';
      const policy = existsSync(policyPath) ? JSON.parse(readFileSync(policyPath, 'utf8')) as ReturnType<typeof defaultPolicy> : defaultPolicy(language, 'static-analysis');
      const report = analyzeWorkspace(context.frozenDirectory, { ...policy, includeFiles: changedFiles.length > 0 ? changedFiles : sourceFiles });
      writeEvidence('static-analysis', 'static-analysis.json', report);
      for (const name of ['simplicity', 'maintainability', 'decoupling'] as const) objective[name] = { score: report.scores[name], evidence: ['static-analysis'], kind: 'static' };
      for (const file of report.files) for (const specifier of file.imports.filter(value => value.startsWith('.'))) {
        const target = resolve(context.frozenDirectory, dirname(file.path), specifier);
        const candidates = [target, target.replace(/\.[cm]?js$/, '.ts'), target + '.ts', target + '.tsx', join(target, 'index.ts')];
        const found = sources.find(source => candidates.includes(resolve(context.frozenDirectory, source.path)));
        if (found) contextPaths.add(found.path);
      }
    } catch (error) { notes.push('静态证据未取得：' + (error instanceof Error ? error.message : String(error))); }
    // 保留每个修改文件的完整前后文；不因未修改的上游/依赖体积丢掉已取得的客观分。
    let sourceBytes = 0;
    let materialError: string | null = null;
    const omitted: string[] = [];
    const orderedSources = [...sources].sort((left, right) => Number(right.baseline !== right.text) - Number(left.baseline !== left.text));
    for (const source of orderedSources) {
      const changed = source.baseline !== source.text;
      if (!changed && changedFiles.length > 0 && !contextPaths.has(source.path)) { omitted.push(source.path); continue; }
      const content = changed ? `修改文件：${source.path}\n起始版本：\n${source.baseline}\n提交版本：\n${source.text}` : `未修改的直接依赖上下文：${source.path}\n${source.text}`;
      if (sourceBytes + Buffer.byteLength(content) > 250000) {
        if (changed) materialError = '修改源码的完整前后文超过 250KB 评审材料上限；客观证据保留，独立评审待定。';
        omitted.push(source.path); continue;
      }
      sourceBytes += Buffer.byteLength(content);
      materials.push({ id: `source-${source.index}`, kind: 'candidate', text: content });
    }
    if (omitted.length > 0) materials.push({ id: 'source-scope', kind: 'evidence', text: JSON.stringify({ changedFiles, omittedUnchangedOrOversizeFiles: omitted, note: '以上文件未附全文，不得假设其具体实现；材料不足时拒绝对应判断，不给无关旧代码扣分。' }) });
    if (options.measurePerformance ?? env.BENCH_MEASURE_PERFORMANCE === '1') {
      try {
        const benchmark = await measureVerificationCost(context);
        writeEvidence('benchmark-samples', 'benchmark-samples.json', benchmark);
        objective.performance = { score: benchmark.result.score, evidence: ['benchmark-samples'], kind: 'benchmark' };
        benchmarkCalibrated = benchmark.result.calibrated;
        notes.push(`性能分来自 ${benchmark.workload} 的外部计时配对实测，包含启动及断言成本；${benchmarkCalibrated ? '匹配冻结校准环境' : '阈值尚未校准'}。`);
      } catch (error) { notes.push('性能证据未取得：' + (error instanceof Error ? error.message : String(error))); }
    } else notes.push('性能测量未启用，performance 客观分保持缺失。');
    let independentReview = false;
    if (options.humanReview !== undefined) {
      const human = options.humanReview;
      if (human.reviewer.trim() === '' || human.reason.trim() === '' || !reviewVerdictValidator.Check(human.verdict)) throw new Error('人工复核必须有有效判决、复核者和原因。');
      if (human.verdict.runId !== context.execution.runId || human.verdict.attemptId !== context.execution.attemptId || human.verdict.taskId !== task.taskId) throw new Error('人工复核与冻结作答不一致。');
      const known = new Set(materials.map(material => material.id));
      if (Object.values(human.verdict.dimensions).some(dimension => dimension.evidence.some(id => !known.has(id)))) throw new Error('人工复核引用了不存在的评审材料。');
      writeEvidence('human-review', 'human-review.json', { ...human, recordedAt: new Date().toISOString(), candidateHash: context.execution.candidateTreeHash });
      review = Object.fromEntries(Object.entries(human.verdict.dimensions).map(([key, value]) => [key, { score: value.score, evidence: ['human-review', ...value.evidence] }]));
      independentReview = true;
    } else {
      try {
        if (materialError) throw new JudgeUnavailableError(materialError);
        const judge = options.judge ?? createEnvironmentJudge(env, context.signal ? { signal: context.signal } : {});
        const frozenConfiguration = judge.configuration;
        const request = { runId: context.execution.runId, attemptId: context.execution.attemptId, taskId: task.taskId, promptVersion: judge.promptVersion, materials: [...materials] };
        writeEvidence('review-materials', 'review-materials.json', { ...request, candidateHash: context.execution.candidateTreeHash,
          ...(frozenConfiguration ? { configuration: frozenConfiguration } : {}) });
        const first = await judge.review({ ...request, roundId: '1' });
        writeEvidence('review-round-1', 'review-round-1.json', first);
        const second = await judge.review({ ...request, roundId: '2' });
        writeEvidence('review-round-2', 'review-round-2.json', second);
        const comparison = compareReviews(first.verdict, second.verdict);
        if (first.configuration?.parametersFingerprint !== second.configuration?.parametersFingerprint
          || (frozenConfiguration && [first, second].some(round => round.configuration?.parametersFingerprint !== frozenConfiguration.parametersFingerprint))) {
          comparison.needsHumanReview = true;
          comparison.reasons.push('两轮实际生成参数未保持相同的冻结配置，不能合并为一个裁判结论。');
        }
        if (first.responseModel !== second.responseModel) {
          comparison.needsHumanReview = true;
          comparison.reasons.push('两轮服务端返回的模型版本不同，等待复核。');
        }
        const firstScore = scoreExecution(context.execution, task, { objective, review: first.verdict.dimensions });
        const secondScore = scoreExecution(context.execution, task, { objective, review: second.verdict.dimensions });
        if (firstScore.thresholdMet !== null && secondScore.thresholdMet !== null && firstScore.thresholdMet !== secondScore.thresholdMet) {
          comparison.needsHumanReview = true;
          comparison.reasons.push('结合已取得的客观分后，两轮判决改变合格门槛。');
        }
        writeEvidence('review-comparison', 'review-comparison.json', comparison);
        if (comparison.needsHumanReview) notes.push('两轮评审差异影响判定，等待人工复核，评审分保持缺失。');
        else {
          review = Object.fromEntries(Object.entries(comparison.averages).map(([key, score]) => [key, { score, evidence: ['review-round-1', 'review-round-2'] }]));
          independentReview = first.source === 'model' && second.source === 'model';
          rehearsal = !independentReview;
          if (!independentReview) notes.push('本轮为脚本评审演练，不属于真实模型验收。');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notes.push(error instanceof JudgeUnavailableError ? message : '独立评审未完成：' + message);
        writeEvidence('review-error', 'review-error.json', { message, at: new Date().toISOString(), totalRemainsPending: true });
      }
    }
    return { objective, ...(rehearsal ? { mode: 'rehearsal' as const } : {}), ...(review === undefined ? {} : { review }), artifacts, notes,
      release: { taskReady: requireTask(task.taskId).status === 'ready', staticCalibrated: false, benchmarkCalibrated, independentReview } };
  };
}
