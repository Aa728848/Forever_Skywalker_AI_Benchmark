import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { tasks, requireTask } from '@fsa/catalog';
import { difficultyLabels, humanReviewValidator, type RunStatus } from '@fsa/contracts';
import { parseAssessment, scoreAssessment } from '@fsa/core';
import { createEnvelope, createRunStore, defaultRunRoot } from '@fsa/runs';
import { listRunStatuses, readExecutionScore, readRunStatus, renderRunReport, reviewCompletedAttempt, verifySubmission } from '@fsa/executor';
import { JudgeUnavailableError } from '@fsa/judge';
import { createQualityProvider, dshJudgeOptionsFromEnvironment, summarizeRuns } from '@fsa/evaluation';
import { repositoryRoot } from '@fsa/tasks';

const usage = [
  '用法：',
  '  bench list | show <题目 ID> | score <证据 JSON> [--format json|markdown]   # 预览语义，不执行候选代码',
  '  bench submit <题目 ID> <候选目录> --key <幂等键> [--by <提交者>] [--reason agent-completed|operator-submit|patch-import]',
  '              [--root <运行存储目录>] [--format json] [--profile local|linux-container] [--image <镜像引用>] [--image-digest sha256:...] [--static]',
  '  静态客观分自动采集；--measure 追加真实参考/候选性能采样；--no-measure 明确跳过。独立 DSH 评分 Agent 从 BENCH_JUDGE_DSH_* 配置读取。',
  '  bench status <runId> <attemptId> [--root <运行存储目录>] [--format json]',
  '  bench runs [--root <运行存储目录>] [--format json]',
  '  bench review <runId> <attemptId> [--human <复核JSON>] [--measure] [--root <运行存储目录>]',
  '  bench review-export <runId> <attemptId> --output <目录> [--root <运行存储目录>]   # 导出脱敏评审材料给外部评分 Agent',
  '  bench report <runId> <attemptId> [--format json|markdown] [--root <运行存储目录>]',
  '  bench summary <作答选择JSON> [--root <运行存储目录>]   # [{runId, attemptId}]，每题显式选择一次',
  '  bench judge-config   # 本地检查裁判有效参数与配置指纹，不发起模型请求，不输出密钥',
  '',
  'submit 是正式提交入口：冻结候选快照并自动触发受控验证，输出不含调用方自报分数。',
].join('\n');

function renderStatus(status: RunStatus, created: boolean, reusedExecution: boolean): string {
  const lines = [
    `题目：${status.taskId} ${status.taskVersion}`,
    `运行/尝试：${status.runId} / ${status.attemptId}`,
    `提交结果：${created ? '已冻结新 attempt' : '复用已冻结 attempt'}${reusedExecution ? '（复用已确认的执行结果）' : ''}`,
    `阶段：${status.phase}`,
    `候选摘要：${status.candidateTreeHash}`,
    `执行结论：${status.classification ?? '尚未执行'}`,
  ];
  if (status.knownFailures.length === 0) lines.push('已知失败：无');
  else for (const failure of status.knownFailures) lines.push(`已知失败：${failure.id}（${failure.kind}${failure.critical ? '，关键项' : ''}）`);
  if (status.missingChecks.length > 0) lines.push(`缺失检查：${status.missingChecks.join('、')}`);
  lines.push(`可重试：${status.retryable.allowed ? `是（${status.retryable.reason}，仅限同一快照）` : '否'}`);
  lines.push(`可用验证：${status.scoring.functional === null ? `未取得（${status.scoring.reason}）` : `${status.scoring.functional} / 50`}`);
  lines.push(`代码质量：${status.scoring.quality === null ? `待定（${status.scoring.reason}）` : `${status.scoring.quality} / 50`}`);
  lines.push(`总分：${status.scoring.total === null ? '待定' : `${status.scoring.total} / 100`}`);
  lines.push(`证据：${status.evidenceRefs.length > 0 ? status.evidenceRefs.join('、') : '无'}`);
  return lines.join('\n');
}

try {
  const { values, positionals } = parseArgs({
    options: {
      format: { type: 'string', default: 'text' },
      key: { type: 'string' },
      by: { type: 'string', default: 'operator' },
      reason: { type: 'string', default: 'operator-submit' },
      root: { type: 'string', default: process.env.BENCH_RUN_DIR || defaultRunRoot },
      profile: { type: 'string', default: process.env.BENCH_PROFILE ?? 'local' },
      image: { type: 'string', ...(process.env.BENCH_IMAGE ? { default: process.env.BENCH_IMAGE } : {}) },
      'image-digest': { type: 'string', ...(process.env.BENCH_IMAGE_DIGEST ? { default: process.env.BENCH_IMAGE_DIGEST } : {}) },
      static: { type: 'boolean', default: false },
      measure: { type: 'boolean' },
      human: { type: 'string' },
      output: { type: 'string' },
    },
    allowPositionals: true,
    allowNegative: true,
  });
  const [command, first, second] = positionals;
  const asJson = values.format === 'json';
  if (!['text', 'json', 'markdown'].includes(values.format)) throw new Error('--format 必须为 text、json 或 markdown。');
  if (positionals.length > 3) throw new Error('位置参数过多。');
  const arity: Record<string, number> = { list: 1, show: 2, score: 2, submit: 3, status: 3, runs: 1, review: 3, 'review-export': 3, report: 3, summary: 2, 'judge-config': 1 };
  if (command && arity[command] !== undefined && positionals.length !== arity[command]) throw new Error('位置参数数量不正确。\n' + usage);

  if (command === 'list' && first === undefined) {
    console.log(tasks.map(task => `${task.id.padEnd(12)} ${difficultyLabels[task.difficulty].padEnd(6)} ${task.title} [${task.status}]`).join('\n'));
  } else if (command === 'show' && first !== undefined) {
    console.log(JSON.stringify(requireTask(first), null, 2));
  } else if (command === 'score' && first !== undefined) {
    const assessment = parseAssessment(JSON.parse(readFileSync(first, 'utf8')) as unknown);
    requireTask(assessment.taskId);
    const result = scoreAssessment(assessment);
    if (values.format === 'markdown') {
      console.log(`# 评分预览：${assessment.taskId}\n\n输入证据由调用方提供，尚未由隔离执行器验证。\n\n| 项目 | 分数 |\n| --- | --- |\n| 可用验证 | ${result.functional ?? '待定'} / 50 |\n| 代码质量 | ${result.quality ?? '待定'} / 50 |\n| 总分 | ${result.total ?? '待定'} / 100 |\n\n状态：${result.readiness}。门槛：${result.thresholdMet === null ? '待定' : result.thresholdMet ? '达到（预览）' : '未达到'}。\n\n${result.reasons.join('\n')}`);
    } else console.log(JSON.stringify(result, null, 2));
  } else if (command === 'submit' && first !== undefined && second !== undefined) {
    requireTask(first);
    if (!['agent-completed', 'operator-submit', 'patch-import'].includes(values.reason)) throw new Error('--reason 必须为 agent-completed、operator-submit 或 patch-import。');
    const store = createRunStore(values.root);
    const envelopeOptions: { idempotencyKey?: string; reason?: 'agent-completed' | 'operator-submit' | 'patch-import' } = {
      reason: values.reason as 'agent-completed' | 'operator-submit' | 'patch-import',
    };
    if (values.key !== undefined) envelopeOptions.idempotencyKey = values.key;
    const envelope = createEnvelope(first, second, envelopeOptions);
    if (!['local', 'linux-container'].includes(values.profile)) throw new Error('--profile 必须为 local 或 linux-container。');
    let judgeSummary = '评审：未配置（需要 BENCH_JUDGE_DSH_PROVIDER / BENCH_JUDGE_DSH_MODEL，并复用 BENCH_DSH_ROOT/HOME），代码质量保持待定。';
    try {
      const config = dshJudgeOptionsFromEnvironment();
      judgeSummary = 'DSH 评分 Agent 已配置：' + config.provider + ' / ' + config.model + '（思考 ' + config.reasoningEffort + '，两轮独立会话）。';
    } catch (error) {
      if (!(error instanceof JudgeUnavailableError)) throw error;
    }
    console.error(judgeSummary);
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort(new Error('操作者取消。')));
    process.once('SIGTERM', () => controller.abort(new Error('进程终止。')));
    const outcome = await verifySubmission({
      store, taskId: first, envelope, candidateDirectory: second, submittedBy: values.by,
      signal: controller.signal,
      qualityProvider: createQualityProvider({ ...(values.measure === undefined ? {} : { measurePerformance: values.measure }) }),
      profile: values.profile === 'linux-container' ? 'linux-container' : 'local',
      ...(values.image === undefined ? {} : { image: values.image }),
      ...(values['image-digest'] === undefined ? {} : { imageDigest: values['image-digest'] }),
    });
    const status = readRunStatus(store, outcome.submission.attempt.runId, outcome.submission.attempt.attemptId);
    if (asJson) console.log(JSON.stringify({ ...status, submission: outcome.submission.outcome, reusedExecution: outcome.reusedExecution }, null, 2));
    else console.log(renderStatus(status, outcome.submission.outcome === 'created', outcome.reusedExecution));
    if (status.classification !== 'passed') process.exitCode = 1;
  } else if (command === 'status' && first !== undefined && second !== undefined) {
    const status = readRunStatus(createRunStore(values.root), first, second);
    console.log(asJson ? JSON.stringify(status, null, 2) : renderStatus(status, false, false));
  } else if (command === 'review' && first !== undefined && second !== undefined) {
    const input: unknown = values.human === undefined ? undefined : JSON.parse(readFileSync(values.human, 'utf8'));
    if (input !== undefined && !humanReviewValidator.Check(input)) throw new Error('人工复核 JSON 不符合协议。');
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort(new Error('操作者取消评审。')));
    process.once('SIGTERM', () => controller.abort(new Error('评审进程终止。')));
    const score = await reviewCompletedAttempt({ store: createRunStore(values.root), runId: first, attemptId: second,
      signal: controller.signal,
      qualityProvider: createQualityProvider({ ...(input === undefined ? {} : { humanReview: input }), ...(values.measure === undefined ? {} : { measurePerformance: values.measure }) }) });
    console.log(JSON.stringify(score, null, 2));
  } else if (command === 'review-export' && first !== undefined && second !== undefined) {
    if (values.output === undefined || values.output.trim() === '') throw new Error('review-export 必须指定 --output <目录>。');
    const store = createRunStore(values.root);
    const attempt = store.readAttempt(first, second);
    if (!attempt) throw new Error('未找到运行记录。');
    const executionDirectories = readdirSync(attempt.directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^execution(?:-[1-9][0-9]*)?$/.test(entry.name))
      .map(entry => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    const executionDirectory = executionDirectories.map(name => join(attempt.directory, name))
      .find(directory => existsSync(join(directory, 'review-materials.json')));
    const materialsPath = executionDirectory === undefined ? undefined : join(executionDirectory, 'review-materials.json');
    if (materialsPath === undefined || !existsSync(materialsPath)) throw new Error('该 attempt 尚未生成评审材料；请先完成一次 submit（即使裁判暂不可用也会生成材料）。');
    const outputDirectory = resolve(values.output);
    const repositoryScope = resolve(repositoryRoot);
    if (outputDirectory === repositoryScope || outputDirectory.startsWith(repositoryScope + '\\') || outputDirectory.startsWith(repositoryScope + '/')) {
      throw new Error('评审导出目录不得位于评测仓库内，请使用仓库外的临时目录。');
    }
    if (existsSync(outputDirectory) && readdirSync(outputDirectory).length > 0) throw new Error(`评审导出目录必须为空：${outputDirectory}`);
    mkdirSync(outputDirectory, { recursive: true });
    const materials = JSON.parse(readFileSync(materialsPath, 'utf8')) as Record<string, unknown>;
    // 只导出评审请求中已允许的 task/candidate/evidence 材料，不复制 candidate、graders 或令牌。
    if (!Array.isArray(materials.materials) || materials.materials.length === 0) throw new Error('评审材料格式无效或为空。');
    writeFileSync(join(outputDirectory, 'review-request.json'), `${JSON.stringify(materials, null, 2)}\n`);
    writeFileSync(join(outputDirectory, 'README.md'), [
      '# 外部 Agent 评审材料', '',
      `runId：${first}`, `attemptId：${second}`, `taskId：${String(materials.taskId ?? attempt.attempt.taskId)}`, '',
      '请仅依据 review-request.json 中的材料，返回符合 `ReviewVerdict` 协议的 JSON（四个维度均需引用材料 id）。',
      '录入时将其包装为 `{"reviewer":"agent-id","reason":"独立评分","verdict":<ReviewVerdict>}`，再运行 `bench review <runId> <attemptId> --human <JSON>`。', '',
      '该目录不包含单独的候选源码目录、隐藏检查、参考补丁或任何 API 令牌；评审所需的候选文本已包含在 review-request.json 中。',
    ].join('\n') + '\n');
    console.log(`已导出评审材料：${outputDirectory}`);
    console.log(`请求：${join(outputDirectory, 'review-request.json')}`);
    console.log(`说明：${join(outputDirectory, 'README.md')}`);
  } else if (command === 'report' && first !== undefined && second !== undefined) {
    const store = createRunStore(values.root);
    if (asJson) {
      const outcome = store.readAttempt(first, second);
      if (!outcome) throw new Error('未找到运行记录。');
      console.log(JSON.stringify({ status: readRunStatus(store, first, second), score: readExecutionScore(outcome.directory) }, null, 2));
    } else console.log(renderRunReport(store, first, second));
  } else if (command === 'summary' && first !== undefined) {
    console.log(JSON.stringify(summarizeRuns(createRunStore(values.root), JSON.parse(readFileSync(first, 'utf8'))), null, 2));
  } else if (command === 'judge-config') {
    const { createDshJudgeFromEnvironment } = await import('@fsa/evaluation');
    const judge = createDshJudgeFromEnvironment();
    console.log(JSON.stringify({ configuration: judge.configuration, networkCall: false }, null, 2));
  } else if (command === 'runs') {
    const statuses = listRunStatuses(createRunStore(values.root));
    if (asJson) console.log(JSON.stringify(statuses, null, 2));
    else if (statuses.length === 0) console.log('运行记录为空。');
    else for (const status of statuses) console.log(`${status.taskId.padEnd(12)} ${status.runId}/${status.attemptId} ${status.phase.padEnd(9)} ${status.classification ?? '-'}`);
  } else {
    throw new Error(usage);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
