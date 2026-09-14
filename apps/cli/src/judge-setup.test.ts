import { afterEach, expect, it, vi } from 'vitest';
import { judgeConfigFromEnvironment, resolveJudgeConfiguration } from '@fsa/judge';
import { collectJudgeSetup, type JudgeSetupIO } from './judge-setup.ts';

afterEach(() => vi.restoreAllMocks());

function fixture(values: Record<string, string | string[]> = {}, token = 'private-test-token') {
  const output: string[] = [];
  const asked: string[] = [];
  const secret = vi.fn(async () => token);
  const queues = new Map(Object.entries(values).map(([key, value]) => [key, Array.isArray(value) ? [...value] : [value]]));
  const io: JudgeSetupIO = {
    say: message => output.push(message), secret,
    ask: async prompt => {
      asked.push(prompt);
      if (prompt.startsWith('1. 现在补齐')) return '1';
      if (prompt.startsWith('输入要重填')) return queues.get('edit')?.shift() ?? 'q';
      const field = /BENCH_JUDGE_([A-Z_]+)/.exec(prompt)?.[1];
      return field ? queues.get(field)?.shift() ?? '' : '';
    },
  };
  return { io, output, asked, secret };
}

it('空环境可分步配置DeepSeek思考和预算，返回待保存项且没有请求或密钥输出', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不能请求网络'));
  const context = fixture({ PROVIDER: 'deepseek', ENDPOINT: 'https://judge.invalid', MODEL: 'deepseek-v4-pro', THINKING: 'enabled', REASONING_EFFORT: 'high' });
  const env = {};
  const updates = await collectJudgeSetup(context.io, env);
  expect(updates).toMatchObject({ BENCH_JUDGE_PROVIDER: 'deepseek', BENCH_JUDGE_MODEL: 'deepseek-v4-pro', BENCH_JUDGE_TOKEN: 'private-test-token', BENCH_JUDGE_REASONING_EFFORT: 'high', BENCH_JUDGE_MAX_CALLS: '2' });
  const { config } = judgeConfigFromEnvironment(updates!);
  expect(resolveJudgeConfiguration(config).parameters).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'high', max_tokens: 16384 });
  expect(context.secret).toHaveBeenCalledOnce();
  expect(context.output.join('\n') + context.asked.join('\n')).not.toContain('private-test-token');
  expect(network).not.toHaveBeenCalled(); expect(env).toEqual({});
});

it.each([
  ['openai', 'gpt-5.5', { REASONING_EFFORT: 'high' }],
  ['anthropic', 'claude-sonnet-4-6', { THINKING: 'adaptive', REASONING_EFFORT: 'high' }],
  ['gemini', 'gemini-2.5-pro', { THINKING_BUDGET: '8192' }],
  ['deepseek', 'deepseek-v4-pro', { THINKING: 'enabled', REASONING_EFFORT: 'max' }],
  ['qwen', 'qwen3.5-plus', { THINKING: 'enabled', THINKING_BUDGET: '8192', STREAM: 'true' }],
  ['xai', 'grok-4.6', { REASONING_EFFORT: 'high' }],
  ['moonshot', 'kimi-k3', { REASONING_EFFORT: 'high' }],
  ['zhipu', 'glm-5.1', { THINKING: 'enabled' }],
  ['openai-compatible', 'user-model', { REASONING_EFFORT: 'high' }],
] as const)('%s通过既有协议校验收集有效思考参数', async (provider, model, settings) => {
  const context = fixture({ PROVIDER: provider, ENDPOINT: 'https://judge.invalid/v1', MODEL: model, ...settings });
  const updates = await collectJudgeSetup(context.io, {});
  expect(updates).not.toBeNull();
  expect(judgeConfigFromEnvironment(updates!).config.provider).toBe(provider);
});

it('已有兼容供应商、模型、密钥和预算不会重问或覆盖，仍提供缺失思考入口', async () => {
  const env = { BENCH_JUDGE_PROVIDER: 'openai-compatible', BENCH_JUDGE_ENDPOINT: 'https://existing.invalid', BENCH_JUDGE_MODEL: 'existing-model', BENCH_JUDGE_TOKEN: 'kept-token', BENCH_JUDGE_MAX_CALLS: '3', BENCH_JUDGE_MAX_INPUT_TOKENS: '50000', BENCH_JUDGE_MAX_OUTPUT_TOKENS: '6000', BENCH_JUDGE_MAX_TOKENS_PER_CALL: '2000', BENCH_JUDGE_TIMEOUT_MS: '45000' };
  const before = { ...env }; const context = fixture({ REASONING_EFFORT: 'low' });
  expect(await collectJudgeSetup(context.io, env)).toEqual({ BENCH_JUDGE_REASONING_EFFORT: 'low' });
  expect(env).toEqual(before); expect(context.secret).not.toHaveBeenCalled();
  expect(context.asked.filter(prompt => /BENCH_JUDGE_(PROVIDER|ENDPOINT|MODEL|MAX_CALLS)/.test(prompt))).toEqual([]);
  expect(context.output.join('\n')).toContain('openai-compatible，本次保持不变');
  expect(context.output.join('\n')).not.toContain('kept-token');
});

it('不支持的思考组合通过原校验器报错后仅重输本次字段，token不重复询问', async () => {
  const context = fixture({ PROVIDER: 'deepseek', ENDPOINT: 'https://judge.invalid', MODEL: 'deepseek-v4-pro', THINKING: 'enabled', REASONING_EFFORT: ['medium', 'high'], edit: 'REASONING_EFFORT' });
  const result = await collectJudgeSetup(context.io, {});
  expect(result?.BENCH_JUDGE_REASONING_EFFORT).toBe('high');
  expect(context.output.join('\n')).toContain('reasoningEffort 仅支持 low/high/max');
  expect(context.secret).toHaveBeenCalledOnce();
});

it('手动Claude预算依赖和HTTP超时都复用既有校验并允许修正', async () => {
  const context = fixture({ PROVIDER: 'anthropic', ENDPOINT: 'https://judge.invalid', MODEL: 'claude-sonnet-4-6', THINKING: 'enabled', THINKING_BUDGET: ['1', '4096'], TIMEOUT_MS: ['0', '300000'], edit: ['THINKING_BUDGET', 'TIMEOUT_MS'] });
  const result = await collectJudgeSetup(context.io, {});
  expect(result).toMatchObject({ BENCH_JUDGE_THINKING_BUDGET: '4096', BENCH_JUDGE_TIMEOUT_MS: '300000' });
  expect(context.output.join('\n')).toContain('手动 thinkingBudget');
  expect(context.output.join('\n')).toContain('评审超时必须为');
});

it('空白提示版本采用既有默认并写回，避免保存后的空串覆盖默认值', async () => {
  const context = fixture({ PROVIDER: 'openai-compatible', ENDPOINT: 'https://judge.invalid', MODEL: 'user-model' });
  const env = { BENCH_JUDGE_PROMPT_VERSION: '' };
  const updates = await collectJudgeSetup(context.io, env);
  expect(updates?.BENCH_JUDGE_PROMPT_VERSION).toBe('review-v1');
  expect(judgeConfigFromEnvironment({ ...env, ...updates }).config.promptVersion).toBe('review-v1');
  expect(env.BENCH_JUDGE_PROMPT_VERSION).toBe('');
});

it('取消或跳过不返回已输入密钥，空白密钥不能通过', async () => {
  const skipped = fixture(); skipped.io.ask = async () => '2';
  expect(await collectJudgeSetup(skipped.io, {})).toEqual({}); expect(skipped.secret).not.toHaveBeenCalled();
  const cancelled = fixture({ PROVIDER: 'deepseek', ENDPOINT: 'https://judge.invalid', MODEL: 'deepseek-v4-pro', THINKING: 'q' });
  expect(await collectJudgeSetup(cancelled.io, {})).toBeNull();
  expect(cancelled.output.join('\n')).not.toContain('private-test-token');
  const empty = fixture({ PROVIDER: 'deepseek', ENDPOINT: 'https://judge.invalid', MODEL: 'deepseek-v4-pro' });
  empty.io.secret = vi.fn().mockResolvedValueOnce(' ').mockResolvedValueOnce(null);
  expect(await collectJudgeSetup(empty.io, {})).toBeNull();
  expect(empty.output).toContain('此项不能为空，请重新填写。');
});
