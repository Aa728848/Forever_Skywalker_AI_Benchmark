import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { tasks, requireTask } from '@fsa/catalog';
import { difficultyLabels, type RunStatus } from '@fsa/contracts';
import { parseAssessment, scoreAssessment } from '@fsa/core';
import { createEnvelope, createRunStore, defaultRunRoot } from '@fsa/runs';
import { listRunStatuses, readRunStatus, verifySubmission } from '@fsa/executor';
import { defaultTypeScriptPolicy } from '@fsa/static';
import { judgeConfigFromEnvironment, JudgeUnavailableError } from '@fsa/judge';

const usage = [
  '用法：',
  '  bench list | show <题目 ID> | score <证据 JSON> [--format json|markdown]   # 预览语义，不执行候选代码',
  '  bench submit <题目 ID> <候选目录> --key <幂等键> [--by <提交者>] [--reason agent-completed|operator-submit|patch-import]',
  '              [--root <运行存储目录>] [--format json] [--profile local|linux-container] [--image <镜像引用>] [--image-digest sha256:...] [--static]',
  '  --static 启用未校准的 TypeScript 静态客观分（只覆盖 simplicity/maintainability/decoupling）。',
  '  bench status <runId> <attemptId> [--root <运行存储目录>] [--format json]',
  '  bench runs [--root <运行存储目录>] [--format json]',
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
      root: { type: 'string', default: defaultRunRoot },
      profile: { type: 'string', default: 'local' },
      image: { type: 'string' },
      'image-digest': { type: 'string' },
      static: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });
  const [command, first, second] = positionals;
  const asJson = values.format === 'json';
  if (!['text', 'json', 'markdown'].includes(values.format)) throw new Error('--format 必须为 text、json 或 markdown。');
  if (positionals.length > 3) throw new Error('位置参数过多。');

  if (command === 'list' && first === undefined) {
    console.log(tasks.map(task => `${task.id.padEnd(12)} ${difficultyLabels[task.difficulty].padEnd(6)} ${task.title} [设计目录]`).join('\n'));
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
    let judgeSummary = '评审：未配置（需要 BENCH_JUDGE_ENDPOINT / BENCH_JUDGE_MODEL / BENCH_JUDGE_TOKEN），代码质量保持待定。';
    try {
      const { config } = judgeConfigFromEnvironment();
      judgeSummary = '评审已配置：' + config.provider + ' ' + config.model + '（提示版本 ' + config.promptVersion + '，预算 ' + config.maxCalls + ' 次）。注意：CLI 尚不自动调用评审，判决需由调度器注入。';
    } catch (error) {
      if (!(error instanceof JudgeUnavailableError)) throw error;
    }
    console.log(judgeSummary);
    const outcome = await verifySubmission({
      store, taskId: first, envelope, candidateDirectory: second, submittedBy: values.by,
      profile: values.profile === 'linux-container' ? 'linux-container' : 'local',
      ...(values.image === undefined ? {} : { image: values.image }),
      ...(values['image-digest'] === undefined ? {} : { imageDigest: values['image-digest'] }),
      ...(values.static !== true ? {} : { staticPolicy: defaultTypeScriptPolicy() }),
    });
    const status = readRunStatus(store, outcome.submission.attempt.runId, outcome.submission.attempt.attemptId);
    if (asJson) console.log(JSON.stringify({ ...status, submission: outcome.submission.outcome, reusedExecution: outcome.reusedExecution }, null, 2));
    else console.log(renderStatus(status, outcome.submission.outcome === 'created', outcome.reusedExecution));
    if (status.classification !== 'passed') process.exitCode = 1;
  } else if (command === 'status' && first !== undefined && second !== undefined) {
    const status = readRunStatus(createRunStore(values.root), first, second);
    console.log(asJson ? JSON.stringify(status, null, 2) : renderStatus(status, false, false));
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
