import { judgeConfigValidator, reviewVerdictValidator, type JudgeConfig, type ReviewVerdict } from '@fsa/contracts';

/**
 * 独立评审适配器：只使用平台配置的模型端点与预算，令牌从环境读取且不落盘。
 * 没有配置时拒绝工作，绝不用固定评语或假设分补齐质量维度。
 */
export class JudgeUnavailableError extends Error {}
export class JudgeBudgetExceededError extends Error {}

export interface ReviewRequest {
  readonly runId: string;
  readonly attemptId: string;
  readonly taskId: string;
  readonly promptVersion: string;
  readonly materials: readonly ReviewMaterial[];
}

export interface ReviewMaterial {
  readonly id: string;
  readonly kind: 'task' | 'candidate' | 'evidence';
  readonly text: string;
}

export interface ReviewOutcome {
  readonly verdict: ReviewVerdict;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface JudgeAdapter {
  readonly model: string;
  readonly promptVersion: string;
  review(request: ReviewRequest): Promise<ReviewOutcome>;
}

export const judgeTokenEnvironmentVariable = 'BENCH_JUDGE_TOKEN';

/** 从环境构造配置；缺少必需项时抛 JudgeUnavailableError（不读取其它项目的私有凭据）。 */
export function judgeConfigFromEnvironment(env: NodeJS.ProcessEnv = process.env): { config: JudgeConfig; token: string } {
  const endpoint = env.BENCH_JUDGE_ENDPOINT;
  const model = env.BENCH_JUDGE_MODEL;
  const token = env[judgeTokenEnvironmentVariable];
  if (endpoint === undefined || model === undefined || token === undefined || token === '') {
    throw new JudgeUnavailableError('评审未配置：需要 BENCH_JUDGE_ENDPOINT、BENCH_JUDGE_MODEL 与 ' + judgeTokenEnvironmentVariable + '。');
  }
  const candidate = {
    provider: env.BENCH_JUDGE_PROVIDER ?? 'openai-compatible',
    model,
    endpoint,
    promptVersion: env.BENCH_JUDGE_PROMPT_VERSION ?? 'review-v1',
    maxCalls: Number(env.BENCH_JUDGE_MAX_CALLS ?? 2),
    maxInputTokens: Number(env.BENCH_JUDGE_MAX_INPUT_TOKENS ?? 60000),
    maxOutputTokens: Number(env.BENCH_JUDGE_MAX_OUTPUT_TOKENS ?? 4000),
  };
  if (!judgeConfigValidator.Check(candidate)) throw new JudgeUnavailableError('评审配置不合法（预算必须是正整数）。');
  return { config: candidate, token };
}

export type ReviewCompletion = (request: ReviewRequest, config: JudgeConfig, token: string) => Promise<{ text: string; inputTokens: number; outputTokens: number }>;

function assertBudget(config: JudgeConfig, calls: number, inputTokens: number, outputTokens: number): void {
  if (calls >= config.maxCalls) throw new JudgeBudgetExceededError('评审调用次数超过预算 ' + config.maxCalls);
  if (inputTokens >= config.maxInputTokens) throw new JudgeBudgetExceededError('评审输入 token 超过预算 ' + config.maxInputTokens);
  if (outputTokens >= config.maxOutputTokens) throw new JudgeBudgetExceededError('评审输出 token 超过预算 ' + config.maxOutputTokens);
}

function verifyVerdict(parsed: unknown, request: ReviewRequest, config: JudgeConfig): ReviewVerdict {
  if (!reviewVerdictValidator.Check(parsed)) throw new JudgeUnavailableError('评审判决不符合 0.1.0 协议。');
  if (parsed.runId !== request.runId || parsed.attemptId !== request.attemptId) {
    throw new JudgeUnavailableError('评审判决的 run/attempt 与请求不一致。');
  }
  if (parsed.promptVersion !== config.promptVersion) throw new JudgeUnavailableError('评审判决的提示版本与配置不一致。');
  return parsed;
}

/** 由调用方注入真正的模型调用；适配器只负责预算、提示版本与判决校验。 */
export function createJudge(config: JudgeConfig, token: string, complete: ReviewCompletion): JudgeAdapter {
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  return {
    model: config.model,
    promptVersion: config.promptVersion,
    async review(request: ReviewRequest): Promise<ReviewOutcome> {
      assertBudget(config, calls, inputTokens, outputTokens);
      const completion = await complete(request, config, token);
      calls += 1;
      inputTokens += completion.inputTokens;
      outputTokens += completion.outputTokens;
      const parsed: unknown = JSON.parse(completion.text);
      return { verdict: verifyVerdict(parsed, request, config), calls, inputTokens, outputTokens };
    },
  };
}

/** 确定性脚本评审：用于测试与本地演练，不是正式分数来源。 */
export function createScriptedJudge(script: readonly string[], model = 'scripted-judge', promptVersion = 'review-v1'): JudgeAdapter {
  let index = 0;
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  return {
    model,
    promptVersion,
    async review(request: ReviewRequest): Promise<ReviewOutcome> {
      const text = script[index];
      index += 1;
      calls += 1;
      if (text === undefined) throw new JudgeUnavailableError('脚本评审没有更多响应了。');
      inputTokens += 100;
      outputTokens += 50;
      const parsed: unknown = JSON.parse(text);
      return { verdict: verifyVerdict(parsed, request, { provider: 'scripted', model, endpoint: 'memory', promptVersion, maxCalls: 100, maxInputTokens: 1000000, maxOutputTokens: 1000000 }), calls, inputTokens, outputTokens };
    },
  };
}

/** 构造一份符合协议的评审判决样本（供测试与演练使用）。 */
export function sampleVerdict(
  request: { runId: string; attemptId: string; taskId: string },
  scores: { simplicity: number; maintainability: number; decoupling: number; performance: number },
  evidence: readonly string[],
  model = 'scripted-judge',
  promptVersion = 'review-v1',
): ReviewVerdict {
  const dimension = (score: number) => ({ score, evidence: [...evidence] });
  return {
    schemaVersion: '0.1.0',
    runId: request.runId,
    attemptId: request.attemptId,
    taskId: request.taskId,
    rubricVersion: '0.1.0',
    model,
    promptVersion,
    dimensions: {
      simplicity: dimension(scores.simplicity),
      maintainability: dimension(scores.maintainability),
      decoupling: dimension(scores.decoupling),
      performance: dimension(scores.performance),
    },
    notes: ['脚本评审样本'],
    cost: { calls: 1, inputTokens: 100, outputTokens: 50 },
    reviewedAt: '2026-01-01T00:00:00.000Z',
  };
}
