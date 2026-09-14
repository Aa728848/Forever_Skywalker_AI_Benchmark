import { createHash } from 'node:crypto';
import { judgeConfigValidator, type JudgeConfig } from '@fsa/contracts';
import { JudgeUnavailableError } from './index.ts';

export interface JudgeConfiguration {
  readonly provider: string;
  readonly api: NonNullable<JudgeConfig['api']>;
  readonly model: string;
  readonly promptVersion: string;
  /** 实际发送的非敏感生成参数；未发送的参数采用供应商默认值。 */
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly parametersFingerprint: string;
}

const defaults: Record<string, NonNullable<JudgeConfig['api']>> = {
  'openai-compatible': 'chat-completions', openai: 'responses', anthropic: 'messages', gemini: 'generate-content',
  deepseek: 'chat-completions', qwen: 'chat-completions', xai: 'chat-completions', moonshot: 'chat-completions', zhipu: 'chat-completions',
};
const openaiEfforts: Record<string, string[]> = {
  'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-sol': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-terra': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-luna': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.5': ['none', 'low', 'medium', 'high', 'xhigh'],
  'gpt-5.4': ['none', 'low', 'medium', 'high', 'xhigh'],
  'gpt-5.2': ['none', 'low', 'medium', 'high', 'xhigh'],
  'gpt-5.1': ['none', 'low', 'medium', 'high'],
  'gpt-5': ['minimal', 'low', 'medium', 'high'],
  'gpt-5-mini': ['minimal', 'low', 'medium', 'high'],
  'gpt-5-nano': ['minimal', 'low', 'medium', 'high'],
  'gpt-5-pro': ['high'],
  'gpt-5.4-pro': ['medium', 'high', 'xhigh'],
  o1: ['low', 'medium', 'high'], o3: ['low', 'medium', 'high'], 'o3-mini': ['low', 'medium', 'high'], 'o4-mini': ['low', 'medium', 'high'],
};

function reject(message: string): never { throw new JudgeUnavailableError('评审配置不合法：' + message); }
function absent(config: JudgeConfig, names: (keyof JudgeConfig)[]): void {
  const found = names.find(name => config[name] !== undefined);
  if (found) reject(config.provider + ' 不支持参数 ' + found + '。');
}
function effort(config: JudgeConfig, allowed: string[]): void {
  if (config.reasoningEffort !== undefined && !allowed.includes(config.reasoningEffort)) reject(config.model + ' 的 reasoningEffort 仅支持 ' + allowed.join('/') + '。');
}

/** 本地校验已经核对的模型能力；不把厂商自动降级/忽略参数当作配置成功。 */
export function resolveJudgeConfiguration(config: JudgeConfig): JudgeConfiguration {
  if (!judgeConfigValidator.Check(config)) reject('字段、枚举或数值不符合协议。');
  const api = config.api ?? defaults[config.provider];
  if (!api || !(config.provider in defaults)) reject('未知 provider。');
  if (api !== defaults[config.provider] && !(config.provider === 'openai' && api === 'chat-completions')) reject(config.provider + ' 不支持此 API 协议。');
  let endpoint: URL;
  try { endpoint = new URL(config.endpoint); } catch { reject('端点必须是 HTTP(S) URL。'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) reject('端点不能包含凭据、查询参数或片段。');
  const cap = config.maxTokensPerCall ?? Math.floor(config.maxOutputTokens / config.maxCalls);
  if (cap < 1 || cap > config.maxOutputTokens) reject('每轮输出上限不能超过总输出预算。');
  const p: Record<string, unknown> = {};
  const model = config.model;
  const thinkingActive = config.thinking === 'enabled' || config.thinking === 'adaptive';
  const qwenThinkingJson = /^qwen3\.(?:7-(?:max|plus|flash)|8-(?:max|flash))(?:-|$)/.test(model);
  const format = config.outputFormat ?? (['anthropic', 'zhipu'].includes(config.provider)
    || (config.provider === 'qwen' && config.thinking !== 'disabled' && !qwenThinkingJson) ? 'prompt-json' : 'json-object');
  const stream = config.stream ?? config.provider === 'moonshot';
  if (stream && api !== 'chat-completions') reject('当前流式接入仅支持 Chat Completions。');

  if (config.provider === 'openai' || config.provider === 'openai-compatible') {
    absent(config, ['thinking', 'thinkingBudget', 'topK']);
    if (api === 'responses' && config.seed !== undefined) reject('Responses 不支持 seed。');
    if (config.provider === 'openai') {
      const family = model.replace(/-\d{4}-\d{2}-\d{2}$/, '');
      const supported = openaiEfforts[family];
      const reasoning = /^(gpt-[56]|o[134])/.test(model);
      if (config.reasoningEffort !== undefined && supported === undefined) reject('此模型未登记 reasoningEffort 能力。');
      if (supported) effort(config, supported);
      if (family.endsWith('-pro') && api !== 'responses') reject('此 Pro 模型仅支持 Responses。');
      if (reasoning && (config.temperature !== undefined || config.topP !== undefined)
        && (!['gpt-5.1', 'gpt-5.2', 'gpt-5.4', 'gpt-5.5'].includes(family) || config.reasoningEffort !== 'none')) reject('此推理配置不支持 temperature/topP；不要依赖供应商忽略参数。');
      if (config.verbosity !== undefined && (!supported || !/^gpt-[56]/.test(model))) reject('此模型未登记 verbosity 能力。');
      if (reasoning && config.seed !== undefined) reject('此推理模型未登记 seed 能力。');
    }
    if (config.reasoningMode !== undefined && !(config.provider === 'openai' && api === 'responses' && /^gpt-5\.6/.test(model))) reject('reasoningMode 仅登记 OpenAI GPT-5.6 Responses。');
    if (api === 'responses') {
      p.max_output_tokens = cap; p.store = false;
      if (config.reasoningEffort !== undefined || config.reasoningMode !== undefined) p.reasoning = {
        ...(config.reasoningEffort === undefined ? {} : { effort: config.reasoningEffort }),
        ...(config.reasoningMode === undefined ? {} : { mode: config.reasoningMode }),
      };
      p.text = { ...(format === 'json-object' ? { format: { type: 'json_object' } } : {}),
        ...(config.verbosity === undefined ? {} : { verbosity: config.verbosity }) };
    } else {
      p.max_completion_tokens = cap;
      if (config.reasoningEffort !== undefined) p.reasoning_effort = config.reasoningEffort;
      if (config.verbosity !== undefined) p.verbosity = config.verbosity;
    }
  } else if (config.provider === 'anthropic') {
    absent(config, ['reasoningMode', 'seed', 'verbosity']);
    if (format !== 'prompt-json') reject('Anthropic 当前使用 prompt-json + 本地严格 Schema 校验。');
    if (!/^claude-/.test(model)) reject('Anthropic 模型名需要 claude- 前缀。');
    const adaptive = /^claude-(?:(?:opus|sonnet)-(?:4-[678]|5)|(?:fable|mythos)-)/.test(model);
    if (config.thinking === 'adaptive' && !adaptive) reject('此模型未登记 adaptive thinking 能力。');
    if (config.thinking === 'enabled') {
      if (/^claude-(?:(?:opus|sonnet)-5|opus-4-[78]|fable-|mythos-)/.test(model)) reject('此模型要求 adaptive，不接受 enabled/budget_tokens。');
      if (config.thinkingBudget === undefined || config.thinkingBudget < 1024 || config.thinkingBudget >= cap) reject('手动 thinkingBudget 必须 >=1024 且小于每轮输出上限。');
    } else if (config.thinkingBudget !== undefined) reject('thinkingBudget 只能搭配 enabled。');
    if (config.thinking === 'disabled' && (/^claude-(fable|mythos)-/.test(model)
      || (/^claude-opus-5/.test(model) && ['xhigh', 'max'].includes(config.reasoningEffort ?? '')))) reject('此模型/effort 不能关闭思考。');
    if (config.reasoningEffort !== undefined) {
      if (!adaptive && !/^claude-opus-4-5/.test(model)) reject('此模型未登记 effort 能力。');
      effort(config, adaptive ? (/^claude-(?:opus-4-6|sonnet-4-6|mythos-preview)/.test(model) ? ['low', 'medium', 'high', 'max'] : ['low', 'medium', 'high', 'xhigh', 'max']) : ['low', 'medium', 'high']);
    }
    const automaticThinking = /^claude-(?:(?:opus|sonnet)-5|fable-|mythos-)/.test(model) && config.thinking !== 'disabled';
    if ((thinkingActive || automaticThinking) && (config.temperature !== undefined || config.topP !== undefined || config.topK !== undefined)) reject('此适配器的 thinking 模式不允许采样参数。');
    if (config.temperature !== undefined && config.temperature > 1) reject('Anthropic temperature 范围 0–1。');
    if (config.temperature !== undefined && config.topP !== undefined) reject('Anthropic 不同时设置 temperature 和 topP。');
    p.max_tokens = cap;
    if (config.thinking !== undefined) p.thinking = { type: config.thinking, ...(config.thinkingBudget === undefined ? {} : { budget_tokens: config.thinkingBudget }) };
    if (config.reasoningEffort !== undefined) p.output_config = { effort: config.reasoningEffort };
  } else if (config.provider === 'gemini') {
    absent(config, ['reasoningMode', 'verbosity', 'thinking']);
    if (config.reasoningEffort !== undefined && config.thinkingBudget !== undefined) reject('Gemini thinkingLevel 与 thinkingBudget 互斥。');
    if (config.reasoningEffort !== undefined) {
      if (!/^gemini-3/.test(model)) reject('thinkingLevel 仅登记 Gemini 3 系列。');
      effort(config, /pro/.test(model) ? ['low', 'high'] : ['minimal', 'low', 'medium', 'high']);
    }
    if (config.thinkingBudget !== undefined) {
      if (!/^gemini-2\.5/.test(model)) reject('thinkingBudget 仅登记 Gemini 2.5 系列；Gemini 3 用 thinkingLevel。');
      const max = /pro/.test(model) ? 32768 : 24576;
      if (config.thinkingBudget > max || (/pro/.test(model) && config.thinkingBudget !== -1 && config.thinkingBudget < 128)) reject('Gemini 2.5 思考预算超出登记范围。');
      if (/flash-lite/.test(model) && config.thinkingBudget > 0 && config.thinkingBudget < 512) reject('Gemini 2.5 Flash-Lite 的正数思考预算至少 512。');
    }
    p.maxOutputTokens = cap; p.candidateCount = 1;
    if (format === 'json-object') p.responseMimeType = 'application/json';
    if (config.reasoningEffort !== undefined || config.thinkingBudget !== undefined) p.thinkingConfig = {
      includeThoughts: false, ...(config.reasoningEffort === undefined ? {} : { thinkingLevel: config.reasoningEffort.toUpperCase() }),
      ...(config.thinkingBudget === undefined ? {} : { thinkingBudget: config.thinkingBudget }),
    };
  } else {
    absent(config, ['reasoningMode', 'verbosity']);
    p.max_tokens = cap;
    if (config.provider === 'deepseek') {
      absent(config, ['thinkingBudget', 'topK', 'seed']);
      if (config.thinking === 'adaptive') reject('DeepSeek thinking 仅 enabled/disabled。');
      effort(config, ['low', 'high', 'max']);
      if (config.reasoningEffort !== undefined && !/^deepseek-(?:flash|pro|v4)/.test(model)) reject('此旧模型未登记 reasoningEffort；使用新版官方模型或省略 effort。');
      if (config.thinking === 'disabled' && config.reasoningEffort !== undefined) reject('关闭思考时不能设置 effort。');
      if (config.thinking !== 'disabled' && config.temperature !== undefined) reject('DeepSeek 思考模式会忽略 temperature。');
      if (config.topP !== undefined && (config.thinking === 'disabled' || config.topP < 0.95)) reject('DeepSeek topP 仅在思考模式 0.95–1 生效。');
      if (config.thinking !== undefined) p.thinking = { type: config.thinking };
      if (config.reasoningEffort !== undefined) p.reasoning_effort = config.reasoningEffort;
    } else if (config.provider === 'qwen') {
      absent(config, ['reasoningEffort']);
      if (!/^qwen/.test(model)) reject('qwen provider 仅接入 Qwen 系列。');
      if (config.thinking === 'adaptive') reject('Qwen 用 enabled/disabled。');
      if (format === 'json-object' && config.thinking !== 'disabled' && !qwenThinkingJson) reject('该 Qwen 思考模式未登记可靠 JSON Object 支持，请显式选择 prompt-json。');
      if (config.thinkingBudget !== undefined && (config.thinking !== 'enabled' || config.thinkingBudget < 1)) reject('Qwen thinkingBudget 是正整数且要求 thinking=enabled。');
      if (config.thinking === 'enabled' && !stream && !/^qwen(?:(?:3(?:\.[5-8])?)-(?:max|plus|flash)|-(?:max|plus|flash))/.test(model)) reject('该 Qwen 思考模型未登记同步输出支持，请配置 stream=true。');
      if (config.thinking !== undefined) p.enable_thinking = config.thinking === 'enabled';
      if (config.thinkingBudget !== undefined) p.thinking_budget = config.thinkingBudget;
    } else if (config.provider === 'xai') {
      absent(config, ['thinking', 'thinkingBudget', 'topK']);
      if (config.reasoningEffort !== undefined) {
        if (/^grok-4\.6/.test(model)) effort(config, ['low', 'medium', 'high', 'xhigh']);
        else if (/^grok-4\.5/.test(model)) effort(config, ['low', 'medium', 'high']);
        else if (/^grok-3-mini/.test(model)) effort(config, ['low', 'high']);
        else reject('此 Grok 模型未登记可调 effort，不能静默映射。');
        p.reasoning_effort = config.reasoningEffort;
      }
    } else if (config.provider === 'moonshot') {
      absent(config, ['thinkingBudget', 'topK', 'seed']);
      if (config.thinking === 'adaptive') reject('Kimi 用 enabled/disabled。');
      if (/^kimi-k3/.test(model)) {
        absent(config, ['thinking', 'temperature', 'topP']); effort(config, ['low', 'high', 'max']);
        if (config.reasoningEffort !== undefined) p.reasoning_effort = config.reasoningEffort;
      } else {
        absent(config, ['reasoningEffort']);
        if (!/^kimi-k2\.[567]/.test(model) && config.thinking !== undefined) reject('此 Kimi 模型未登记 thinking 开关。');
        if (/^kimi-k2\.7/.test(model) && config.thinking === 'disabled') reject('Kimi K2.7 Code 不能关闭思考。');
        const expectedTemperature = config.thinking === 'disabled' ? 0.6 : 1;
        if (config.temperature !== undefined && config.temperature !== expectedTemperature) reject('该 Kimi 模式 temperature 固定为 ' + expectedTemperature + '。');
        if (config.topP !== undefined && config.topP !== 0.95) reject('该 Kimi 模型 topP 固定为 0.95。');
        if (config.thinking !== undefined) p.thinking = { type: config.thinking };
      }
    } else if (config.provider === 'zhipu') {
      absent(config, ['reasoningEffort', 'thinkingBudget', 'topK', 'seed']);
      if (format !== 'prompt-json') reject('GLM 当前使用 prompt-json + 本地严格 Schema 校验。');
      if (config.thinking === 'adaptive') reject('GLM 用 enabled/disabled。');
      if (config.thinking !== undefined && !/^glm-(?:4\.[5-9]|5)/.test(model)) reject('thinking 仅登记 GLM 4.5 及以上。');
      if (config.temperature !== undefined && config.temperature > 1) reject('GLM temperature 范围 0–1。');
      if (config.topP !== undefined && config.topP < 0.01) reject('GLM topP 范围 0.01–1。');
      if (config.thinking !== undefined) p.thinking = { type: config.thinking };
    }
  }
  for (const [key, wire] of [['temperature', 'temperature'], ['topP', api === 'generate-content' ? 'topP' : 'top_p'],
    ['topK', api === 'generate-content' ? 'topK' : 'top_k'], ['seed', 'seed']] as const) if (config[key] !== undefined) p[wire] = config[key];
  if (api === 'chat-completions') {
    p.stream = stream;
    if (stream) p.stream_options = { include_usage: true };
    if (format === 'json-object') p.response_format = { type: 'json_object' };
  } else if (api !== 'generate-content') p.stream = false;
  const base = { provider: config.provider, api, model, promptVersion: config.promptVersion, parameters: p };
  // 端点参与摘要以隔离网关；明文 URL、令牌与材料不会进入评审报告。
  const parametersFingerprint = createHash('sha256').update(JSON.stringify([endpoint.toString(), base])).digest('hex');
  return { ...base, parametersFingerprint };
}
