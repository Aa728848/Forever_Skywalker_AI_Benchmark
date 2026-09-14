import { judgeConfigValidator, reviewVerdictValidator, type JudgeConfig, type ReviewVerdict } from '@fsa/contracts';
import { createHash } from 'node:crypto';
export { createEnvironmentJudge, createOpenAICompatibleCompletion } from './http.ts';
export { compareReviews } from './comparison.ts';
import { resolveJudgeConfiguration, type JudgeConfiguration } from './configuration.ts';
export { resolveJudgeConfiguration, type JudgeConfiguration } from './configuration.ts';

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
  /** 独立评审轮次；同轮、同材料复用结果，不重复消耗调用预算。 */
  readonly roundId?: string;
}

export interface ReviewMaterial {
  readonly id: string;
  readonly kind: 'task' | 'candidate' | 'evidence';
  readonly text: string;
}

export interface ReviewOutcome {
  readonly verdict: ReviewVerdict;
  readonly calls: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly source: 'model' | 'scripted';
  readonly configuration?: JudgeConfiguration;
  readonly usageDetails?: Readonly<Record<string, number>>;
  readonly responseModel?: string;
  readonly dshSession?: { id: string; version: string; presetFingerprint: string; durationMs: number; observedRoutes: { provider: string; model: string }[] };
}

export interface JudgeAdapter {
  readonly model: string;
  readonly promptVersion: string;
  readonly configuration?: JudgeConfiguration;
  review(request: ReviewRequest): Promise<ReviewOutcome>;
}

export const judgeTokenEnvironmentVariable = 'BENCH_JUDGE_TOKEN';

/** 从环境构造配置；缺少必需项时抛 JudgeUnavailableError（不读取其它项目的私有凭据）。 */
export function judgeConfigFromEnvironment(env: NodeJS.ProcessEnv = process.env): { config: JudgeConfig; token: string } {
  const endpoint = env.BENCH_JUDGE_ENDPOINT;
  const model = env.BENCH_JUDGE_MODEL;
  const token = env[judgeTokenEnvironmentVariable];
  if (endpoint === undefined || model === undefined || token === undefined || [endpoint, model, token].some(value => value.trim() === '')) {
    throw new JudgeUnavailableError('评审未配置：需要 BENCH_JUDGE_ENDPOINT、BENCH_JUDGE_MODEL 与 ' + judgeTokenEnvironmentVariable + '。');
  }
  const candidate: Record<string, unknown> = {
    provider: env.BENCH_JUDGE_PROVIDER ?? 'openai-compatible',
    model,
    endpoint,
    promptVersion: env.BENCH_JUDGE_PROMPT_VERSION ?? 'review-v1',
    maxCalls: Number(env.BENCH_JUDGE_MAX_CALLS ?? 2),
    maxInputTokens: Number(env.BENCH_JUDGE_MAX_INPUT_TOKENS ?? 60000),
    maxOutputTokens: Number(env.BENCH_JUDGE_MAX_OUTPUT_TOKENS ?? 4000),
  };
  const fields = { API: 'api', REASONING_EFFORT: 'reasoningEffort', REASONING_MODE: 'reasoningMode', THINKING: 'thinking',
    THINKING_BUDGET: 'thinkingBudget', TEMPERATURE: 'temperature', TOP_P: 'topP', TOP_K: 'topK', SEED: 'seed',
    VERBOSITY: 'verbosity', MAX_TOKENS_PER_CALL: 'maxTokensPerCall', OUTPUT_FORMAT: 'outputFormat', STREAM: 'stream' } as const;
  const allowedEnvironment = new Set(['PROVIDER', 'ENDPOINT', 'MODEL', 'TOKEN', 'PROMPT_VERSION', 'MAX_CALLS', 'MAX_INPUT_TOKENS', 'MAX_OUTPUT_TOKENS', 'TIMEOUT_MS', ...Object.keys(fields)].map(name => 'BENCH_JUDGE_' + name));
  if (Object.keys(env).some(name => name.startsWith('BENCH_JUDGE_') && !allowedEnvironment.has(name))) throw new JudgeUnavailableError('存在未知 BENCH_JUDGE_* 配置项；请检查拼写，不支持任意参数透传。');
  for (const [name, field] of Object.entries(fields)) {
    const value = env['BENCH_JUDGE_' + name];
    if (value === undefined || value.trim() === '') continue;
    if (field === 'stream') {
      if (!['true', 'false'].includes(value)) throw new JudgeUnavailableError('BENCH_JUDGE_STREAM 必须为 true/false。');
      candidate[field] = value === 'true';
    } else candidate[field] = ['thinkingBudget', 'temperature', 'topP', 'topK', 'seed', 'maxTokensPerCall'].includes(field) ? Number(value) : value;
  }
  if (!judgeConfigValidator.Check(candidate)) throw new JudgeUnavailableError('评审配置不合法（预算必须是正整数）。');
  resolveJudgeConfiguration(candidate);
  return { config: candidate, token };
}

export type ReviewCompletion = (request: ReviewRequest, config: JudgeConfig, token: string) => Promise<{
  text: string; inputTokens: number; outputTokens: number; configuration?: JudgeConfiguration;
  usageDetails?: Readonly<Record<string, number>>; responseModel?: string;
}>;

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
  if (parsed.taskId !== request.taskId || parsed.model !== config.model || parsed.rubricVersion !== '0.1.0') {
    throw new JudgeUnavailableError('评审判决的题目、模型或评分规则版本与请求不一致。');
  }
  const ids = new Set(request.materials.map(material => material.id));
  for (const dimension of Object.values(parsed.dimensions)) {
    if (dimension.evidence.some(id => !ids.has(id))) throw new JudgeUnavailableError('评审判决引用了未提供的证据。');
  }
  return parsed;
}

function verifyRequest(request: ReviewRequest, config: Pick<JudgeConfig, 'promptVersion'>): void {
  if (request.promptVersion !== config.promptVersion) throw new JudgeUnavailableError('评审请求的提示版本与配置不一致。');
  if (request.materials.length === 0 || new Set(request.materials.map(material => material.id)).size !== request.materials.length
    || request.materials.some(material => material.id.trim() === '' || material.text.trim() === '')) {
    throw new JudgeUnavailableError('评审材料不能为空，且材料 ID 不得重复。');
  }
}

/** 由调用方注入真正的模型调用；适配器只负责预算、提示版本与判决校验。 */
export function createJudge(config: JudgeConfig, token: string, complete: ReviewCompletion): JudgeAdapter {
  if (!judgeConfigValidator.Check(config) || token.trim() === '') throw new JudgeUnavailableError('评审配置或令牌不合法。');
  config = structuredClone(config);
  // 每轮上限在首次调用前固定，不能因剩余额度而改变第二轮生成配置。
  if (config.provider !== 'scripted') config.maxTokensPerCall ??= Math.floor(config.maxOutputTokens / config.maxCalls);
  const configuration = config.provider === 'scripted' ? undefined : resolveJudgeConfiguration(config);
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const cache = new Map<string, ReviewOutcome>();
  return {
    model: config.model,
    promptVersion: config.promptVersion,
    ...(configuration === undefined ? {} : { get configuration() { return structuredClone(configuration); } }),
    review(request: ReviewRequest): Promise<ReviewOutcome> {
      const frozen = structuredClone(request);
      const pending = queue.then(async (): Promise<ReviewOutcome> => {
        verifyRequest(frozen, config);
        const key = createHash('sha256').update(JSON.stringify([config, frozen])).digest('hex');
        const cached = cache.get(key);
        if (cached !== undefined) return structuredClone(cached);
        assertBudget(config, calls, inputTokens, outputTokens);
        if (config.maxTokensPerCall !== undefined && config.maxOutputTokens - outputTokens < config.maxTokensPerCall) {
          throw new JudgeBudgetExceededError('剩余输出预算不足以保持相同的每轮参数，停止后续评审。');
        }
        calls += 1;
        let completion: Awaited<ReturnType<ReviewCompletion>>;
        try {
          completion = await complete(frozen, { ...config, maxCalls: config.maxCalls - calls + 1,
            maxInputTokens: config.maxInputTokens - inputTokens, maxOutputTokens: config.maxOutputTokens - outputTokens }, token);
        } catch (error) {
          // 失败的远端调用可能已经计费；用尽该适配器余量，禁止凭未知用量继续重试。
          inputTokens = config.maxInputTokens;
          outputTokens = config.maxOutputTokens;
          throw error;
        }
        if (![completion.inputTokens, completion.outputTokens].every(value => Number.isSafeInteger(value) && value >= 0)) {
          inputTokens = config.maxInputTokens;
          outputTokens = config.maxOutputTokens;
          throw new JudgeUnavailableError('模型没有返回有效的实际 token 用量，停止后续调用。');
        }
        inputTokens += completion.inputTokens;
        outputTokens += completion.outputTokens;
        if (configuration && completion.configuration && configuration.parametersFingerprint !== completion.configuration.parametersFingerprint) {
          throw new JudgeUnavailableError('实际请求参数与冻结的评审配置不一致。');
        }
        if (inputTokens > config.maxInputTokens || outputTokens > config.maxOutputTokens) throw new JudgeBudgetExceededError('模型实际 token 用量超过剩余预算，本轮不产生判决。');
        let parsed: unknown;
        try { parsed = JSON.parse(completion.text); }
        catch { throw new JudgeUnavailableError('评审响应不是合法 JSON。'); }
        const verdict = verifyVerdict(parsed, frozen, config);
        // 成本与时间来自平台，不能采信模型在 JSON 中声明的计费数字。
        const outcome: ReviewOutcome = { verdict: { ...verdict, cost: { calls: 1, inputTokens: completion.inputTokens,
          outputTokens: completion.outputTokens }, reviewedAt: new Date().toISOString() }, calls, inputTokens, outputTokens, source: 'model',
          ...(configuration === undefined ? {} : { configuration }),
          ...(completion.usageDetails === undefined ? {} : { usageDetails: completion.usageDetails }),
          ...(completion.responseModel === undefined ? {} : { responseModel: completion.responseModel }),
        };
        cache.set(key, structuredClone(outcome));
        return outcome;
      });
      queue = pending.catch(() => undefined);
      return pending;
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
      verifyRequest(request, { promptVersion });
      const text = script[index];
      index += 1;
      calls += 1;
      if (text === undefined) throw new JudgeUnavailableError('脚本评审没有更多响应了。');
      inputTokens += 100;
      outputTokens += 50;
      const parsed: unknown = JSON.parse(text);
      return { verdict: verifyVerdict(parsed, request, { provider: 'scripted', model, endpoint: 'memory', promptVersion, maxCalls: 100, maxInputTokens: 1000000, maxOutputTokens: 1000000 }), calls, inputTokens, outputTokens, source: 'scripted' };
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
