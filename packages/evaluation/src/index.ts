import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { requireTask } from '@fsa/catalog';
import { reviewVerdictValidator, type ExecutionArtifact, type ReviewVerdict } from '@fsa/contracts';
import { scoreExecution, type QualityEvidence } from '@fsa/core';
import type { QualityProvider } from '@fsa/executor';
import { JudgeProtocolError, JudgeUnavailableError, mergeReviewRounds, type JudgeAdapter, type ReviewMaterial, type ReviewOutcome } from '@fsa/judge';
import { analyzeWorkspace, defaultPolicy } from '@fsa/static';
import { listFiles, taskPackageDir } from '@fsa/tasks';
import { measureVerificationCost } from './benchmark.ts';
import { createDshJudgeFromEnvironment } from './dsh-judge.ts';
import { DshCleanupError } from './dsh.ts';
export { createDshJudgeFromEnvironment, dshJudgeOptionsFromEnvironment } from './dsh-judge.ts';
export { discoverDshModels, discoverDshPresets, mergeProjectProviders, profilePluginSpecifiers, type DshCatalogProvider, type DshCatalogSource, type DshModelCatalog } from './dsh-catalog.ts';
export {
  dshPresetLabels, dshWorkspacePermissionLabels, emptyProviderStore, projectProviderRowId, projectProviderStorePath,
  providerInputModalities, providerPatchRows, providerProfileApis, providerProfileValue, providerThinkingFormats,
  providerThinkingLevels, readProjectProviderStore, resolveDshPreset, resolveDshWorkspacePermission,
  validateProviderProfile, writeProjectProviderStore,
  type ProviderFieldError, type ProviderModelProfile, type ProviderProfile, type ProjectProviderStore,
} from './dsh.ts';
export { inspectRunSelection, summarizeRuns } from './suite.ts';

export interface EvaluationOptions {
  judge?: JudgeAdapter;
  env?: NodeJS.ProcessEnv;
  measurePerformance?: boolean;
  humanReview?: { reviewer: string; reason: string; verdict: ReviewVerdict };
  onJudgeCleanupError?: (error: DshCleanupError) => void;
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
    const writeArtifact = (id: string, filename: string, value: unknown): string => {
      const text = JSON.stringify(value, null, 2) + '\n';
      writeFileSync(join(context.artifactDirectory, filename), text);
      artifacts.push({ id, path: filename, sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) });
      return text;
    };
    const writeEvidence = (id: string, filename: string, value: unknown) => {
      materials.push({ id, kind: 'evidence', text: writeArtifact(id, filename, value) });
    };
    // 失败轮次的原始响应只作证据留档，不进评审材料，也不影响后续轮次输入。
    const writeRoundFailure = (roundId: string, error: unknown) => {
      const detail = error instanceof JudgeProtocolError
        ? { roundId, message: error.message, issues: error.issues, rawResponse: error.rawResponse, at: new Date().toISOString() }
        : { roundId, message: error instanceof Error ? error.message : String(error), at: new Date().toISOString() };
      writeArtifact('review-round-' + roundId + '-error', 'review-round-' + roundId + '-error.json', detail);
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
    // 性能维度已从评分口径移除：这里的受控验证成本配对测量的是「验证链路耗时」，
    // 不是候选代码本身的性能，用它给候选打分名不副实。测量本身仍有价值——它是
    // 发布校准需要的环境事实与参考/候选对照证据，因此保留采集与留档，只是不再产生维度分。
    if (options.measurePerformance ?? env.BENCH_MEASURE_PERFORMANCE === '1') {
      try {
        const benchmark = await measureVerificationCost(context);
        writeEvidence('benchmark-samples', 'benchmark-samples.json', benchmark);
        benchmarkCalibrated = benchmark.result.calibrated;
        notes.push(`性能测量已采集但不参与评分：${benchmark.workload} 的外部计时配对实测（包含启动及断言成本），${benchmarkCalibrated ? '匹配冻结校准环境' : '阈值尚未校准'}。`);
      } catch (error) { notes.push('性能证据未取得：' + (error instanceof Error ? error.message : String(error))); }
    } else notes.push('性能测量未启用（不影响评分，性能维度已移除）。');
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
        const judge = options.judge ?? createDshJudgeFromEnvironment(env, context.signal ? { signal: context.signal } : {});
        const frozenConfiguration = judge.configuration;
        const request = { runId: context.execution.runId, attemptId: context.execution.attemptId, taskId: task.taskId, promptVersion: judge.promptVersion, materials: [...materials] };
        writeEvidence('review-materials', 'review-materials.json', { ...request, candidateHash: context.execution.candidateTreeHash,
          ...(frozenConfiguration ? { configuration: frozenConfiguration } : {}) });
        const reviewRound = async (roundId: string) => {
          try { return await judge.review({ ...request, roundId }); }
          catch (error) { writeRoundFailure(roundId, error); throw error; }
        };
        /**
         * 两轮互相独立：任一轮失败不得影响另一轮的结果。
         *
         * 旧实现对第 1 轮 await 后直接抛出，于是第 1 轮一旦失败，第 2 轮**根本不会发起**，
         * 整题质量分与总分永久待定（实测 Google 的 LSP-02 第 1 轮会话 error：报告里只有
         * review-round-1-error，没有 review-round-2）。同理第 2 轮失败会连第 1 轮已取得的
         * 有效判决一起丢掉（实测 MiniMax 的 ARCH-01/INT-WEB：第 1 轮三维都是有效分数）。
         *
         * 现在两轮都跑、各自留档，成功几轮就用几轮；只有两轮都没有任何有效维度时才真的待定。
         */
        // 轮次 id 与结果一同保存：只按数组下标回推轮次会在第 1 轮失败时把第 2 轮错标成第 1 轮。
        const succeeded: { roundId: string; outcome: ReviewOutcome }[] = [];
        const failedRounds: string[] = [];
        let roundFailure: unknown = null;
        for (const roundId of ['1', '2']) {
          try {
            const outcome = await reviewRound(roundId);
            writeEvidence('review-round-' + roundId, 'review-round-' + roundId + '.json', outcome);
            succeeded.push({ roundId, outcome });
          } catch (error) {
            // 裁判会话清理失败属环境问题，仍然上抛；其余失败已写入 review-round-N-error 留档。
            if (error instanceof DshCleanupError) throw error;
            roundFailure = error;
            failedRounds.push(roundId);
          }
        }
        if (succeeded.length === 0) throw roundFailure instanceof Error ? roundFailure : new JudgeUnavailableError('两轮独立评审均未取得有效判决。');
        for (const { roundId, outcome } of succeeded) {
          if (outcome.normalizations !== undefined && outcome.normalizations.length > 0) {
            notes.push('第 ' + roundId + ' 轮判决经平台归一化：' + outcome.normalizations.join('、') + '；四维分数与证据引用未改动。');
          }
        }
        if (failedRounds.length > 0) notes.push('第 ' + failedRounds.join('、') + ' 轮独立评审未取得有效判决（原始响应与字段路径见 review-round-N-error）；其余轮次的有效判决照常采用。');
        const comparison = mergeReviewRounds(succeeded.map(entry => entry.outcome.verdict));
        /**
         * 「两轮不可比」与「两轮分数不同」是两件事，必须分开：
         * 前者说明这两轮根本不是同一个实验条件（配置/模型版本/运行时变了），
         * 此时平均值仍然给出（用户要求两次不同就取平均），但必须留下明确告警，
         * 因为它的可比性是有瑕疵的。后者只是正常的评审波动，取平均即可，无需额外告警。
         */
        const comparabilityWarnings: string[] = [];
        // 只有多轮时才谈「轮次之间是否可比」；单轮无从比较，由 mergeReviewRounds 自行告警。
        if (succeeded.length > 1) {
          const fingerprints = new Set(succeeded.map(entry => entry.outcome.configuration?.parametersFingerprint));
          if (fingerprints.size > 1
            || (frozenConfiguration && succeeded.some(entry => entry.outcome.configuration?.parametersFingerprint !== frozenConfiguration.parametersFingerprint))) {
            comparabilityWarnings.push('各轮实际生成参数未保持相同的冻结配置。');
          }
          if (new Set(succeeded.map(entry => entry.outcome.responseModel)).size > 1) comparabilityWarnings.push('各轮服务端返回的模型版本不同。');
          if (new Set(succeeded.map(entry => entry.outcome.dshSession?.version)).size > 1
            || new Set(succeeded.map(entry => entry.outcome.dshSession?.presetFingerprint)).size > 1) {
            comparabilityWarnings.push('各轮 DSH 评分运行时或评分配置发生变化。');
          }
        }
        // 门槛结论在各轮之间不一致时不再作废分数，但同样要留告警。
        const roundThresholds = new Set(succeeded.map(entry =>
          scoreExecution(context.execution, task, { objective, review: entry.outcome.verdict.dimensions }).thresholdMet));
        if (roundThresholds.size > 1) comparabilityWarnings.push('结合已取得的客观分后，各轮判决给出不同的合格门槛结论。');
        comparison.comparabilityWarnings = [...comparison.comparabilityWarnings, ...comparabilityWarnings];
        // needsHumanReview 只表示「轮次之间不可比」，不表示「分数不同」：
        // 正常分歧由 averages 取平均消化，不该再被当成需要人工介入的异常。
        comparison.needsHumanReview = comparison.comparabilityWarnings.length > 0;
        writeEvidence('review-comparison', 'review-comparison.json', comparison);
        // 所有取得的轮次都没判定任何维度时，才真正没有可用的评审分。
        const unjudgedEverywhere = Object.values(comparison.averages).every(score => score === null);
        if (unjudgedEverywhere) {
          notes.push('各轮评审均未判定任何维度，评审分保持缺失（没有可平均的结论）。');
        } else {
          // 证据引用如实指向真正给出该维分数的轮次，不虚报不存在的轮次。
          const roundEvidence = succeeded.map(entry => 'review-round-' + entry.roundId);
          review = Object.fromEntries(Object.entries(comparison.averages).filter(([, score]) => score !== null)
            .map(([key, score]) => [key, { score, evidence: roundEvidence }]));
          for (const warning of comparison.comparabilityWarnings) notes.push('评审可比性告警：' + warning + ' 分数仍按可用轮次给出，复核时请注意。');
          independentReview = succeeded.every(entry => entry.outcome.source === 'model');
          rehearsal = !independentReview;
          if (!independentReview) notes.push('本轮为脚本评审演练，不属于真实模型验收。');
        }
      } catch (error) {
        if (error instanceof DshCleanupError) options.onJudgeCleanupError?.(error);
        const message = error instanceof Error ? error.message : String(error);
        notes.push(error instanceof JudgeUnavailableError ? message : '独立评审未完成：' + message);
        writeEvidence('review-error', 'review-error.json', { message, at: new Date().toISOString(), totalRemainsPending: true,
          ...(error instanceof JudgeProtocolError ? { roundId: error.roundId, issues: error.issues } : {}) });
      }
    }
    return { objective, ...(rehearsal ? { mode: 'rehearsal' as const } : {}), ...(review === undefined ? {} : { review }), artifacts, notes,
      release: { taskReady: requireTask(task.taskId).status === 'ready', staticCalibrated: false, benchmarkCalibrated, independentReview } };
  };
}
