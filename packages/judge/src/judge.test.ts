import { describe, expect, it, vi } from 'vitest';
import type { JudgeConfig } from '@fsa/contracts';
import {
  JudgeBudgetExceededError, JudgeUnavailableError, createJudge, createScriptedJudge,
  judgeConfigFromEnvironment, sampleVerdict, type ReviewRequest,
  compareReviews, createOpenAICompatibleCompletion,
} from './index.ts';

const request: ReviewRequest = {
  runId: 'run-1',
  attemptId: 'attempt-1',
  taskId: 'CACHE-02',
  promptVersion: 'review-v1',
  materials: [{ id: 'candidate-1', kind: 'candidate', text: 'export const x = 1;' }],
};

const config: JudgeConfig = {
  provider: 'scripted',
  model: 'scripted-judge',
  endpoint: 'memory',
  promptVersion: 'review-v1',
  maxCalls: 2,
  maxInputTokens: 1000,
  maxOutputTokens: 500,
};

const scores = { simplicity: 80, maintainability: 70, decoupling: 60, performance: 50 };

describe('评审配置来自环境', () => {
  it('缺少必需环境变量时拒绝工作，且不读取其它凭据', () => {
    expect(() => judgeConfigFromEnvironment({})).toThrow(JudgeUnavailableError);
    expect(() => judgeConfigFromEnvironment({ BENCH_JUDGE_ENDPOINT: 'https://example', BENCH_JUDGE_MODEL: 'm' })).toThrow(/BENCH_JUDGE_TOKEN/);
  });

  it('配置齐备时给出校验过的配置与令牌', () => {
    const { config: parsed, token } = judgeConfigFromEnvironment({
      BENCH_JUDGE_ENDPOINT: 'https://example', BENCH_JUDGE_MODEL: 'judge-1', BENCH_JUDGE_TOKEN: 'secret',
      BENCH_JUDGE_MAX_CALLS: '3', BENCH_JUDGE_PROMPT_VERSION: 'review-v2',
    });
    expect(parsed).toMatchObject({ model: 'judge-1', promptVersion: 'review-v2', maxCalls: 3 });
    expect(token).toBe('secret');
  });

  it('预算非法时拒绝配置', () => {
    expect(() => judgeConfigFromEnvironment({
      BENCH_JUDGE_ENDPOINT: 'https://example', BENCH_JUDGE_MODEL: 'judge-1', BENCH_JUDGE_TOKEN: 'secret', BENCH_JUDGE_MAX_CALLS: '0',
    })).toThrow(JudgeUnavailableError);
  });
});

describe('适配器预算与判决校验', () => {
  it('超过调用预算后拒绝继续评审', async () => {
    const verdict = JSON.stringify(sampleVerdict(request, scores, ['candidate-1']));
    const judge = createJudge({ ...config, maxCalls: 1 }, 'secret', async () => ({ text: verdict, inputTokens: 10, outputTokens: 5 }));
    const first = await judge.review(request);
    expect(first.calls).toBe(1);
    expect(first.verdict.dimensions.simplicity.score).toBe(80);
    expect((await judge.review(request)).calls).toBe(1);
    await expect(judge.review({ ...request, roundId: 'second' })).rejects.toThrow(JudgeBudgetExceededError);
  });

  it('拒绝与请求不一致或提示版本不符的判决', async () => {
    const mismatched = JSON.stringify(sampleVerdict({ runId: 'run-2', attemptId: 'attempt-1', taskId: 'CACHE-02' }, scores, ['candidate-1']));
    const judgeA = createJudge(config, 'secret', async () => ({ text: mismatched, inputTokens: 1, outputTokens: 1 }));
    await expect(judgeA.review(request)).rejects.toThrow(/run\/attempt/);

    const wrongPrompt = JSON.stringify(sampleVerdict(request, scores, ['candidate-1'], 'scripted-judge', 'review-v9'));
    const judgeB = createJudge(config, 'secret', async () => ({ text: wrongPrompt, inputTokens: 1, outputTokens: 1 }));
    await expect(judgeB.review(request)).rejects.toThrow(/提示版本/);
  });

  it('拒绝分数越界或缺少证据的判决', async () => {
    const outOfRange = JSON.stringify(sampleVerdict(request, { ...scores, simplicity: 101 }, ['candidate-1']));
    const judge = createJudge(config, 'secret', async () => ({ text: outOfRange, inputTokens: 1, outputTokens: 1 }));
    await expect(judge.review(request)).rejects.toThrow(JudgeUnavailableError);

    const noEvidence = JSON.stringify(sampleVerdict(request, scores, []));
    const judge2 = createJudge(config, 'secret', async () => ({ text: noEvidence, inputTokens: 1, outputTokens: 1 }));
    await expect(judge2.review(request)).rejects.toThrow(JudgeUnavailableError);
  });

  it('同时到达的两轮请求不能突破一次调用预算，重复同轮可复用', async () => {
    let finish!: () => void;
    const wait = new Promise<void>(resolve => { finish = resolve; });
    const complete = vi.fn(async () => { await wait; return { text: JSON.stringify(sampleVerdict(request, scores, ['candidate-1'])), inputTokens: 10, outputTokens: 5 }; });
    const judge = createJudge({ ...config, maxCalls: 1 }, 'secret', complete);
    const first = judge.review(request);
    const repeated = judge.review(request);
    const second = judge.review({ ...request, roundId: 'second' });
    finish();
    const result = await Promise.allSettled([first, repeated, second]);
    expect(result.map(item => item.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('调用失败后未知用量禁止自动重试；成功响应也不能越过token预算', async () => {
    const complete = vi.fn(async () => { throw new Error('remote failed'); });
    const failed = createJudge(config, 'secret', complete);
    await expect(failed.review(request)).rejects.toThrow('remote failed');
    await expect(failed.review(request)).rejects.toThrow(JudgeBudgetExceededError);
    expect(complete).toHaveBeenCalledTimes(1);
    const over = createJudge(config, 'secret', async () => ({ text: JSON.stringify(sampleVerdict(request, scores, ['candidate-1'])), inputTokens: 1001, outputTokens: 2 }));
    await expect(over.review(request)).rejects.toThrow(JudgeBudgetExceededError);
  });

  it('拒绝未知证据、错题及错模型，成本使用实际usage覆盖模型自报', async () => {
    for (const change of [{ taskId: 'FE-01' }, { model: 'wrong' }, { dimensions: sampleVerdict(request, scores, ['invented']).dimensions }]) {
      const verdict = { ...sampleVerdict(request, scores, ['candidate-1']), ...change };
      const judge = createJudge(config, 'secret', async () => ({ text: JSON.stringify(verdict), inputTokens: 10, outputTokens: 5 }));
      await expect(judge.review(request)).rejects.toThrow(JudgeUnavailableError);
    }
    const judge = createJudge(config, 'secret', async () => ({ text: JSON.stringify(sampleVerdict(request, scores, ['candidate-1'])), inputTokens: 10, outputTokens: 5 }));
    expect((await judge.review(request)).verdict.cost).toEqual({ calls: 1, inputTokens: 10, outputTokens: 5 });
  });
});

describe('网络完成适配器', () => {
  const networkConfig = { ...config, provider: 'openai-compatible', endpoint: 'https://judge.example/v1', maxInputTokens: 60000, maxOutputTokens: 4000 };
  it('发送固定模型/预算和隔离的材料，读取服务usage，不信模型声明成本', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(sampleVerdict(request, scores, ['candidate-1'])) } }],
      usage: { prompt_tokens: 123, completion_tokens: 45 },
    }), { status: 200 }));
    const judge = createJudge(networkConfig, 'secret', createOpenAICompatibleCompletion({ fetch }));
    const outcome = await judge.review(request);
    expect(outcome.verdict.cost).toEqual({ calls: 1, inputTokens: 123, outputTokens: 45 });
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://judge.example/v1/chat/completions');
    const body = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string) as { max_completion_tokens: number; messages: { content: string }[] };
    expect(body.max_completion_tokens).toBe(2000);
    expect(body.messages[1]?.content).toContain(request.materials[0]!.text);
  });

  it('材料超过输入预算时不发送，服务错误不泄露返回正文或令牌', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('secret token diagnostics', { status: 500 }));
    const complete = createOpenAICompatibleCompletion({ fetch });
    await expect(complete(request, { ...networkConfig, maxInputTokens: 1 }, 'secret')).rejects.toThrow(JudgeBudgetExceededError);
    expect(fetch).not.toHaveBeenCalled();
    await expect(complete(request, networkConfig, 'secret')).rejects.toThrow('HTTP 500');
  });

  it('截断响应或没有usage保持待评审', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] })));
    await expect(createOpenAICompatibleCompletion({ fetch })(request, networkConfig, 'secret')).rejects.toThrow(/完整文本或实际 usage/);
  });
});

describe('独立双轮比较', () => {
  it('保留各维均值，超过20分或可能改变门槛时请求人工复核', () => {
    const first = sampleVerdict(request, scores, ['candidate-1']);
    const second = sampleVerdict(request, { ...scores, simplicity: 59 }, ['candidate-1']);
    expect(compareReviews(first, second)).toMatchObject({ needsHumanReview: true, averages: { simplicity: 69.5 }, differences: { simplicity: 21 } });
    expect(compareReviews(first, first).needsHumanReview).toBe(false);
    expect(() => compareReviews(first, { ...second, attemptId: 'another' })).toThrow(/同一冻结作答/);
  });
});

describe('脚本评审', () => {
  it('按顺序返回判决并累计成本，用尽后拒绝', async () => {
    const judge = createScriptedJudge([JSON.stringify(sampleVerdict(request, scores, ['candidate-1']))]);
    const outcome = await judge.review(request);
    expect(outcome.verdict.taskId).toBe('CACHE-02');
    expect(outcome.inputTokens).toBe(100);
    await expect(judge.review(request)).rejects.toThrow(/没有更多响应/);
  });
});
