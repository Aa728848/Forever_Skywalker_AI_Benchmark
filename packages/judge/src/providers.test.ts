import { describe, expect, it, vi } from 'vitest';
import { parseEnv } from 'node:util';
import type { JudgeConfig } from '@fsa/contracts';
import { createJudge, createOpenAICompatibleCompletion, judgeConfigFromEnvironment, resolveJudgeConfiguration, sampleVerdict, type ReviewRequest } from './index.ts';

const request: ReviewRequest = { runId: 'r', attemptId: 'a', taskId: 'CACHE-02', promptVersion: 'review-v1', materials: [{ id: 'src', kind: 'candidate', text: '代码中文😀' }] };
const base: JudgeConfig = { provider: 'openai', endpoint: 'https://judge.example/v1', model: 'gpt-6-astra', promptVersion: 'review-v1', maxCalls: 2, maxInputTokens: 100000, maxOutputTokens: 16000, maxTokensPerCall: 8000 };
const verdict = (model: string) => JSON.stringify(sampleVerdict(request, { simplicity: 70, maintainability: 80, decoupling: 90, performance: 80 }, ['src'], model));
function chat(model: string) { return { model, choices: [{ finish_reason: 'stop', message: { content: verdict(model), reasoning_content: 'DO NOT SAVE ME' } }], usage: { prompt_tokens: 100, completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 200 } } }; }
function capture(data: unknown) {
  const send = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(data)));
  return { send, complete: createOpenAICompatibleCompletion({ fetch: send }), body: () => JSON.parse(send.mock.calls[0]![1]!.body as string) as Record<string, unknown> };
}

describe('原生协议与供应商参数', () => {
  it('OpenAI Responses 保留完整状态与 inclusive reasoning usage，Chat 映射不同字段', async () => {
    const c = capture({ model: 'gpt-6-astra-2026-09', status: 'completed', output: [
      { type: 'reasoning', summary: [{ text: 'DO NOT SAVE ME' }] }, { type: 'message', status: 'completed', content: [{ type: 'output_text', text: verdict(base.model) }] },
    ], usage: { input_tokens: 100, output_tokens: 300, output_tokens_details: { reasoning_tokens: 200 } } });
    const result = await c.complete(request, { ...base, reasoningEffort: 'max', verbosity: 'low' }, 'private');
    expect(c.body()).toMatchObject({ input: expect.any(Array), max_output_tokens: 8000, reasoning: { effort: 'max' }, text: { verbosity: 'low', format: { type: 'json_object' } }, store: false });
    expect(result).toMatchObject({ inputTokens: 100, outputTokens: 300, responseModel: 'gpt-6-astra-2026-09', usageDetails: { reasoningTokens: 200 } });
    expect(JSON.stringify(result)).not.toContain('DO NOT SAVE ME');
    const legacy = capture(chat(base.model));
    await legacy.complete(request, { ...base, api: 'chat-completions', reasoningEffort: 'high' }, 'private');
    expect(legacy.body()).toMatchObject({ reasoning_effort: 'high', max_completion_tokens: 8000 });
    expect(legacy.body()).not.toHaveProperty('reasoning');
  });

  it('Anthropic 分离system，正确累计cache输入且不重复计算思考输出', async () => {
    const model = 'claude-sonnet-4-6';
    const c = capture({ model, stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'DO NOT SAVE ME' }, { type: 'text', text: verdict(model) }],
      usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 300, output_tokens_details: { thinking_tokens: 200 } } });
    const result = await c.complete(request, { ...base, provider: 'anthropic', model, thinking: 'adaptive', reasoningEffort: 'high' }, 'private');
    expect(c.body()).toMatchObject({ system: expect.any(String), messages: [{ role: 'user', content: expect.any(String) }], thinking: { type: 'adaptive' }, output_config: { effort: 'high' }, max_tokens: 8000 });
    expect(c.send.mock.calls[0]![1]!.headers).toEqual({ 'content-type': 'application/json', 'x-api-key': 'private', 'anthropic-version': '2023-06-01' });
    expect(result).toMatchObject({ inputTokens: 150, outputTokens: 300, usageDetails: { reasoningTokens: 200 } });
    const manual = resolveJudgeConfiguration({ ...base, provider: 'anthropic', model: 'claude-opus-4-5', thinking: 'enabled', thinkingBudget: 2048 });
    expect(manual.parameters.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
  });

  it('Gemini 思考等级与预算分代，cached输入不再加，thoughts输出只加一次', async () => {
    const model = 'gemini-3-flash-preview';
    const c = capture({ modelVersion: model, candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'DO NOT SAVE ME', thought: true }, { text: verdict(model) }] } }],
      usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 40, candidatesTokenCount: 80, thoughtsTokenCount: 220, totalTokenCount: 400 } });
    const result = await c.complete(request, { ...base, provider: 'gemini', model, endpoint: 'https://judge.example/v1beta', reasoningEffort: 'high', topK: 32, seed: 42 }, 'private');
    expect(String(c.send.mock.calls[0]![0])).toBe('https://judge.example/v1beta/models/gemini-3-flash-preview:generateContent');
    expect(c.body()).toMatchObject({ generationConfig: { thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: false }, topK: 32, seed: 42, responseMimeType: 'application/json' } });
    expect(result).toMatchObject({ inputTokens: 100, outputTokens: 300, usageDetails: { reasoningTokens: 220 } });
    expect(resolveJudgeConfiguration({ ...base, provider: 'gemini', model: 'gemini-2.5-pro', thinkingBudget: 2048 }).parameters.thinkingConfig).toEqual({ thinkingBudget: 2048, includeThoughts: false });
  });

  it.each([
    { provider: 'deepseek', model: 'deepseek-flash', thinking: 'enabled', reasoningEffort: 'max', topP: 0.95, expected: { thinking: { type: 'enabled' }, reasoning_effort: 'max', top_p: 0.95 } },
    { provider: 'qwen', model: 'qwen3.5-plus', thinking: 'enabled', thinkingBudget: 2048, expected: { enable_thinking: true, thinking_budget: 2048 } },
    { provider: 'xai', model: 'grok-4.6', reasoningEffort: 'xhigh', expected: { reasoning_effort: 'xhigh' } },
    { provider: 'moonshot', model: 'kimi-k3', reasoningEffort: 'max', expected: { reasoning_effort: 'max' } },
    { provider: 'zhipu', model: 'glm-5.1', thinking: 'enabled', temperature: 0.8, expected: { thinking: { type: 'enabled' }, temperature: 0.8 } },
  ] as const)('$provider 使用本厂商参数，不发送OpenAI专用输出字段', async ({ expected, ...settings }) => {
    const c = capture(chat(settings.model));
    const result = await c.complete(request, { ...base, ...settings, stream: false }, 'private');
    expect(c.body()).toMatchObject({ ...expected, max_tokens: 8000 });
    expect(c.body()).not.toHaveProperty('max_completion_tokens');
    expect(result.outputTokens).toBe(300);
  });
});

describe('推理参数拒绝无效组合和静默降级', () => {
  it.each([
    { provider: 'openai', model: 'gpt-6-astra', reasoningEffort: 'none' },
    { provider: 'openai', model: 'gpt-6-astra', temperature: 0 },
    { provider: 'openai', model: 'gpt-5.1', reasoningEffort: 'xhigh' },
    { provider: 'openai', model: 'gpt-5-pro', reasoningEffort: 'low' },
    { provider: 'openai', model: 'gpt-5-pro', api: 'chat-completions' },
    { provider: 'openai', model: 'gpt-5.4-pro', reasoningEffort: 'none' },
    { provider: 'openai', model: 'gpt-5.4-pro', api: 'chat-completions' },
    { provider: 'openai', model: 'gpt-5.99', reasoningEffort: 'high' },
    { provider: 'anthropic', model: 'claude-opus-4-7', thinking: 'enabled', thinkingBudget: 2048 },
    { provider: 'anthropic', model: 'claude-sonnet-4-6', thinking: 'enabled', thinkingBudget: 8000 },
    { provider: 'anthropic', model: 'claude-sonnet-4-6', thinking: 'adaptive', thinkingBudget: 2048 },
    { provider: 'anthropic', model: 'claude-sonnet-4-6', thinking: 'adaptive', temperature: 1 },
    { provider: 'gemini', model: 'gemini-3-flash-preview', reasoningEffort: 'high', thinkingBudget: 2048 },
    { provider: 'gemini', model: 'gemini-2.5-pro', thinkingBudget: 0 },
    { provider: 'deepseek', model: 'deepseek-flash', thinking: 'enabled', temperature: 1 },
    { provider: 'deepseek', model: 'deepseek-flash', thinking: 'enabled', topP: 0.8 },
    { provider: 'deepseek', model: 'deepseek-v4-pro', thinking: 'enabled', reasoningEffort: 'medium' },
    { provider: 'deepseek', model: 'deepseek-v4-pro', thinking: 'disabled', reasoningEffort: 'high' },
    { provider: 'qwen', model: 'qwen3-32b', thinking: 'enabled', stream: false },
    { provider: 'qwen', model: 'qwen-plus', thinkingBudget: 2048 },
    { provider: 'xai', model: 'grok-4.5', reasoningEffort: 'xhigh' },
    { provider: 'moonshot', model: 'kimi-k3', thinking: 'disabled' },
    { provider: 'zhipu', model: 'glm-5', temperature: 1.5 },
    { provider: 'unknown', model: 'judge' },
  ] as const)('拒绝 $provider/$model 的不支持配置', async settings => {
    const c = capture(chat(settings.model));
    await expect(c.complete(request, { ...base, ...settings }, 'private')).rejects.toThrow(/配置不合法/);
    expect(c.send).not.toHaveBeenCalled();
  });

  it('环境严格解析显式参数；禁止透传任意JSON，端点不得藏凭据', () => {
    const env = { BENCH_JUDGE_PROVIDER: 'anthropic', BENCH_JUDGE_ENDPOINT: base.endpoint, BENCH_JUDGE_MODEL: 'claude-opus-4-5', BENCH_JUDGE_TOKEN: 'secret',
      BENCH_JUDGE_THINKING: 'enabled', BENCH_JUDGE_THINKING_BUDGET: '1024', BENCH_JUDGE_MAX_TOKENS_PER_CALL: '4096', BENCH_JUDGE_MAX_OUTPUT_TOKENS: '8192' };
    expect(judgeConfigFromEnvironment(env).config).toMatchObject({ thinking: 'enabled', thinkingBudget: 1024 });
    expect(() => judgeConfigFromEnvironment({ ...env, BENCH_JUDGE_STREAM: 'yes' })).toThrow(/true\/false/);
    expect(() => judgeConfigFromEnvironment({ ...env, BENCH_JUDGE_REASONING_EFFORTT: 'high' })).toThrow(/未知/);
    expect(() => resolveJudgeConfiguration({ ...base, endpoint: 'https://example/v1?key=private' })).toThrow(/凭据/);
    expect(() => resolveJudgeConfiguration({ ...base, extraBody: { temperature: 0 } } as JudgeConfig)).toThrow(/字段/);
  });

  it('.env 思考等级传入 DeepSeek 两轮实际请求，关闭思考省略等级并区分配置身份', async () => {
    const fingerprints: string[] = [];
    for (const level of ['high', 'max', ''] as const) {
      const env = parseEnv(`
BENCH_JUDGE_PROVIDER=deepseek
BENCH_JUDGE_ENDPOINT=https://judge.example/v1
BENCH_JUDGE_MODEL=deepseek-v4-pro
BENCH_JUDGE_TOKEN=test-only
BENCH_JUDGE_THINKING=${level ? 'enabled' : 'disabled'}
BENCH_JUDGE_REASONING_EFFORT=${level}
BENCH_JUDGE_MAX_TOKENS_PER_CALL=16384
BENCH_JUDGE_MAX_OUTPUT_TOKENS=32768
`);
      const { config, token } = judgeConfigFromEnvironment(env);
      const c = capture(chat(config.model));
      const judge = createJudge(config, token, c.complete);
      const first = await judge.review({ ...request, roundId: '1' });
      const second = await judge.review({ ...request, roundId: '2' });
      expect(c.send).toHaveBeenCalledTimes(2);
      for (const call of c.send.mock.calls) {
        const body = JSON.parse(call[1]!.body as string) as Record<string, unknown>;
        expect(body).toMatchObject({ model: config.model, thinking: { type: level ? 'enabled' : 'disabled' }, max_tokens: 16384 });
        if (level) expect(body.reasoning_effort).toBe(level);
        else expect(body).not.toHaveProperty('reasoning_effort');
      }
      expect(first.configuration?.parametersFingerprint).toBe(second.configuration?.parametersFingerprint);
      expect(first.configuration?.parametersFingerprint).toEqual(expect.any(String));
      fingerprints.push(first.configuration!.parametersFingerprint);
    }
    expect(new Set(fingerprints).size).toBe(3);
  });
});

describe('评审流、完整性、参数身份与预算', () => {
  it('流缺DONE、错误结束或缺usage不能产生判决', async () => {
    const event = { choices: [{ index: 0, delta: { content: '{}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2 } };
    for (const wire of [
      'data: ' + JSON.stringify(event) + '\n\n',
      'data: ' + JSON.stringify({ ...event, usage: undefined }) + '\n\ndata: [DONE]\n\n',
      'data: ' + JSON.stringify({ ...event, choices: [{ index: 0, delta: { content: '{}' }, finish_reason: 'length' }] }) + '\n\ndata: [DONE]\n\n',
    ]) {
      const send = vi.fn<typeof fetch>(async () => new Response(wire));
      await expect(createOpenAICompatibleCompletion({ fetch: send })(request, { ...base, provider: 'moonshot', model: 'kimi-k3' }, 'private')).rejects.toThrow(/完整文本或实际 usage/);
    }
  });
  it('跨UTF8/CRLF分块流只保存答案，最后usage覆盖且不保存思考', async () => {
    const model = 'kimi-k3';
    const wire = [
      { model, choices: [{ index: 0, delta: { reasoning_content: 'DO NOT SAVE ME' }, finish_reason: null }] },
      { model, choices: [{ index: 0, delta: { content: verdict(model) }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 300 } },
    ].map(item => 'data: ' + JSON.stringify(item) + '\r\n\r\n').join('') + 'data: [DONE]\r\n\r\n';
    const bytes = new TextEncoder().encode(wire);
    const send = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); } })));
    const result = await createOpenAICompatibleCompletion({ fetch: send })(request, { ...base, provider: 'moonshot', model, reasoningEffort: 'high' }, 'private');
    expect(result.text).toBe(verdict(model)); expect(result.outputTokens).toBe(300);
    expect(JSON.stringify(result)).not.toContain('DO NOT SAVE ME');
    expect(JSON.parse(send.mock.calls[0]![1]!.body as string)).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  it.each([
    { api: 'responses', provider: 'openai', model: 'gpt-6-astra', data: { status: 'incomplete', output: [], usage: { input_tokens: 1, output_tokens: 2 } } },
    { api: 'messages', provider: 'anthropic', model: 'claude-sonnet-4-6', data: { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 1, output_tokens: 2 } } },
    { api: 'generate-content', provider: 'gemini', model: 'gemini-3-flash-preview', data: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{}' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: 5, totalTokenCount: 30 } } },
    { api: 'chat-completions', provider: 'openai-compatible', model: 'judge', data: { choices: [{ finish_reason: 'stop', message: { content: '{}' } }] } },
  ] as const)('拒绝 $api 截断/用量缺失或不一致', async ({ data, ...settings }) => {
    const c = capture(data); await expect(c.complete(request, { ...base, ...settings }, 'private')).rejects.toThrow(/完整文本或实际 usage/);
  });

  it('固定两轮参数与缓存，配置或思考深度变化导致新指纹，不泄露secret', async () => {
    const c = capture(chat(base.model));
    const cfg = { ...base, api: 'chat-completions' as const, reasoningEffort: 'high' as const };
    const judge = createJudge(cfg, 'private', c.complete);
    cfg.reasoningEffort = 'low' as 'high';
    const first = await judge.review({ ...request, roundId: '1' });
    const second = await judge.review({ ...request, roundId: '2' });
    await judge.review({ ...request, roundId: '1' });
    expect(c.send).toHaveBeenCalledTimes(2);
    expect(c.send.mock.calls.map(call => (JSON.parse(call[1]!.body as string) as Record<string, unknown>).max_completion_tokens)).toEqual([8000, 8000]);
    expect(first.configuration?.parametersFingerprint).toBe(second.configuration?.parametersFingerprint);
    expect(first.configuration?.parametersFingerprint).not.toBe(resolveJudgeConfiguration(cfg).parametersFingerprint);
    expect(JSON.stringify(first.configuration)).not.toMatch(/private|judge\.example/);
  });

  it('剩余额度不足不能降低第二轮输出上限，缺usage后也不能重试', async () => {
    const complete = vi.fn(async () => ({ text: verdict(base.model), inputTokens: 100, outputTokens: 9000 }));
    const judge = createJudge(base, 'private', complete);
    await judge.review({ ...request, roundId: '1' });
    await expect(judge.review({ ...request, roundId: '2' })).rejects.toThrow(/相同的每轮参数/);
    expect(complete).toHaveBeenCalledTimes(1);
    const c = capture({ choices: [{ finish_reason: 'stop', message: { content: verdict(base.model) } }] });
    const failed = createJudge({ ...base, api: 'chat-completions' }, 'private', c.complete);
    await expect(failed.review(request)).rejects.toThrow(/usage/);
    await expect(failed.review({ ...request, roundId: '2' })).rejects.toThrow(/预算/);
    expect(c.send).toHaveBeenCalledTimes(1);
  });
});
