import { describe, expect, it } from 'vitest';
import type { JudgeConfig } from '@fsa/contracts';
import {
  JudgeBudgetExceededError, JudgeUnavailableError, createJudge, createScriptedJudge,
  judgeConfigFromEnvironment, sampleVerdict, type ReviewRequest,
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
    await expect(judge.review(request)).rejects.toThrow(JudgeBudgetExceededError);
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
