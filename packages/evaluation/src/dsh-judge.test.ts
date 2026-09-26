import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { JudgeProtocolError, sampleVerdict, type ReviewRequest } from '@fsa/judge';
import { createDshJudgeFromEnvironment, type DshJudgeDependencies } from './dsh-judge.ts';
import type { DshRunOptions, DshRunResult } from './dsh.ts';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fsa-dsh-judge-')); roots.push(root);
  const dsh = join(root, 'dsh');
  const files: Record<string, string> = {
    'packages/sdk/client/package.json': JSON.stringify({ name: '@deepseek-ai/dsh-sdk-client', version: '1.2.3' }),
    'apps/cli/package.json': JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.2.3' }),
    'packages/sdk/client/lib/index.js': '', 'apps/cli/lib/bin.js': '',
  };
  for (const [path, value] of Object.entries(files)) { const target = join(dsh, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, value); }
  const env = { BENCH_DSH_ROOT: dsh, BENCH_DSH_HOME: join(root, 'home'), BENCH_DSH_PROFILE: 'sdk', BENCH_DSH_WORKSPACE_PERMISSION: 'read-only',
    BENCH_JUDGE_DSH_PROVIDER: 'deepseek-official', BENCH_JUDGE_DSH_MODEL: 'deepseek-v4-pro', BENCH_JUDGE_DSH_REASONING_EFFORT: 'high' };
  return { root, env };
}
const request: ReviewRequest = { runId: 'run-1', attemptId: 'attempt-1', taskId: 'CACHE-02', promptVersion: 'dsh-review-v1', roundId: '1', materials: [
  { id: 'task-contract', kind: 'task' as const, text: 'contract' }, { id: 'candidate-1', kind: 'candidate' as const, text: 'source' },
] };
afterEach(() => { for (const root of roots.splice(0)) rmSync(resolve(root), { recursive: true, force: true }); });

it('uses the DSH workspace chain, disables review tools, and parses a valid verdict', async () => {
  const { env } = fixture(); const launches: DshRunOptions[] = [];
  const run: DshJudgeDependencies['run'] = vi.fn(async (options: DshRunOptions): Promise<DshRunResult> => {
    launches.push(options);
    return { finishReason: 'completed', finalResponse: JSON.stringify(sampleVerdict(request, { simplicity: 80, maintainability: 70, decoupling: 90 }, ['candidate-1'], env.BENCH_JUDGE_DSH_MODEL, request.promptVersion)), usage: null,
      requestedModel: { provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort ?? null, maxTokens: options.maxTokens }, requestedPreset: 'minimal', observedPresets: ['minimal'], presetFingerprint: 'f'.repeat(64), observedRoutes: [{ provider: options.provider, model: options.model }], responseModels: [], dshVersion: '1.2.3', runtimeClosed: true, cleanupScope: 'sdk-runtime', durationMs: 1 };
  });
  const judge = createDshJudgeFromEnvironment(env, { run });
  const result = await judge.review(request);
  expect(result.verdict.dimensions.simplicity.score).toBe(80); expect(launches[0]!.workspacePermission).toBe('read-only'); expect(launches[0]!.reviewOnly).toBe(true);
  expect(result.inputTokens).toBeNull(); expect(result.configuration?.provider).toBe('dsh:deepseek-official');
});

it('accepts a verdict that declares a dimension unjudgeable and writes structured notes', async () => {
  // 真实故障（2026-09-26）：提示词要求「无法从材料判断时拒绝输出判决，不能猜分」，
  // 模型照做，把某一维的 score 写成 null 并按提示词的六个字段交了 notes 对象。
  // 契约当时只收 number 与 string，整份有效判决被判协议错误，质量分与总分永远待定。
  const { env } = fixture();
  const verdict = sampleVerdict(request, { simplicity: 88, maintainability: 90, decoupling: 100 }, ['candidate-1'], env.BENCH_JUDGE_DSH_MODEL, request.promptVersion);
  (verdict.dimensions.decoupling as { score: number | null }).score = null;
  (verdict as unknown as { notes: unknown[] }).notes = [{ dimension: 'decoupling', ruleId: 'DECOUPLE-UNJUDGEABLE',
    materialId: 'candidate-1', location: 'starter/src/keyed-loader.ts', symptom: '材料不足以判断依赖边界', impact: '拒绝猜分，声明不可判' }];
  const run: DshJudgeDependencies['run'] = vi.fn(async (options: DshRunOptions): Promise<DshRunResult> => ({
    finishReason: 'completed', finalResponse: JSON.stringify(verdict), usage: null,
    requestedModel: { provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort ?? null, maxTokens: options.maxTokens },
    requestedPreset: 'minimal', observedPresets: ['minimal'], presetFingerprint: 'f'.repeat(64),
    observedRoutes: [{ provider: options.provider, model: options.model }], responseModels: [], dshVersion: '1.2.3',
    runtimeClosed: true, cleanupScope: 'sdk-runtime', durationMs: 1,
  } as DshRunResult));
  const result = await createDshJudgeFromEnvironment(env, { run }).review(request);
  expect(result.verdict.dimensions.decoupling.score).toBeNull();
  expect(result.verdict.dimensions.simplicity.score).toBe(88);
  // 结构化 note 被压成可读字符串，六个字段的内容一字不丢。
  expect(result.verdict.notes).toHaveLength(1);
  expect(result.verdict.notes[0]).toContain('dimension=decoupling');
  expect(result.verdict.notes[0]).toContain('ruleId=DECOUPLE-UNJUDGEABLE');
  expect(result.verdict.notes[0]).toContain('symptom=材料不足以判断依赖边界');
  expect(result.normalizations).toContain('压平结构化 notes');
});

it('tells the judge that an unjudgeable dimension is declared with null', async () => {
  // 提示词必须说明 null 这种写法，否则模型只能猜，而猜错会让整份判决作废。
  const { env } = fixture(); const prompts: string[] = [];
  const run: DshJudgeDependencies['run'] = vi.fn(async (options: DshRunOptions): Promise<DshRunResult> => {
    prompts.push(options.prompt);
    return { finishReason: 'completed', finalResponse: JSON.stringify(sampleVerdict(request, { simplicity: 80, maintainability: 80, decoupling: 80 }, ['candidate-1'], env.BENCH_JUDGE_DSH_MODEL, request.promptVersion)), usage: null,
      requestedModel: { provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort ?? null, maxTokens: options.maxTokens },
      requestedPreset: 'minimal', observedPresets: ['minimal'], presetFingerprint: 'f'.repeat(64),
      observedRoutes: [{ provider: options.provider, model: options.model }], responseModels: [], dshVersion: '1.2.3',
      runtimeClosed: true, cleanupScope: 'sdk-runtime', durationMs: 1 } as DshRunResult;
  });
  await createDshJudgeFromEnvironment(env, { run }).review(request);
  expect(prompts[0]).toContain('该维 score 写 null');
  // 模板必须给出 note 实例，否则模型无从得知该用字符串还是六字段对象。
  expect(prompts[0]).toContain('dimension=simplicity');
});
it('retries a round whose response is unparseable, then keeps the valid verdict', async () => {
  // 现场证据（2026-09-26 的 55 题实验）：3 轮因模型在中文文本里写裸 ASCII 引号而截断 JSON，
  // 例如 impact=任务只要求"丢失确认后必须重读事实"，成功路径...
  // 旧实现任一轮失败即 calls=2 耗尽预算，整题永久作废；现在重试该轮一次。
  const { env } = fixture();
  let attempt = 0;
  const callsPerRound = new Map<string, number>();
  const valid = JSON.stringify(sampleVerdict(request, { simplicity: 80, maintainability: 80, decoupling: 80 }, ['candidate-1'], env.BENCH_JUDGE_DSH_MODEL, request.promptVersion));
  const run: DshJudgeDependencies['run'] = vi.fn(async (options: DshRunOptions): Promise<DshRunResult> => {
    attempt += 1;
    // 第一次：模拟被裸引号截断的响应。
    const body = attempt === 1 ? '{"schemaVersion":"0.1.0","notes":["impact=任务只要求"丢失确认后必须重读事实"，成功路径..."]}' : valid;
    return { finishReason: 'completed', finalResponse: body, usage: null,
      requestedModel: { provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort ?? null, maxTokens: options.maxTokens },
      requestedPreset: 'minimal', observedPresets: ['minimal'], presetFingerprint: 'f'.repeat(64),
      observedRoutes: [{ provider: options.provider, model: options.model }], responseModels: [], dshVersion: '1.2.3',
      runtimeClosed: true, cleanupScope: 'sdk-runtime', durationMs: 1 } as DshRunResult;
  });
  const result = await createDshJudgeFromEnvironment(env, { run }).review(request);
  expect(attempt).toBe(2);
  expect(result.verdict.dimensions.simplicity.score).toBe(80);
  expect(result.normalizations?.join('；')).toContain('第 1 轮第 1 次响应无效');

  // 完整两轮闭环：第 1 轮有效、第 2 轮先坏一次再成功。
  // 这正是 STATE-01 / STATE-03 的现场形态——当时第 2 轮彻底失败，整题被作废。
  // 注意：sessionId 每次尝试都是新 uuid，不能按它计数——要按**轮次**计数。
  // 轮次由 promptFor 写进 prompt（"roundId":…），这里从提示词里取。
  const roundTwoBadFirst = vi.fn(async (options: DshRunOptions): Promise<DshRunResult> => {
    const round = /"roundId":"([^"]+)"/.exec(options.prompt)?.[1] ?? '?';
    callsPerRound.set(round, (callsPerRound.get(round) ?? 0) + 1);
    const seen = callsPerRound.get(round)!;
    const body = seen === 1
      ? '{"schemaVersion":"0.1.0","notes":["impact=任务只要求"丢失确认后必须重读事实"，成功路径..."]}'
      : JSON.stringify(sampleVerdict({ ...request, roundId: '2' } as ReviewRequest, { simplicity: 78, maintainability: 80, decoupling: 80 }, ['candidate-1'], env.BENCH_JUDGE_DSH_MODEL, request.promptVersion));
    return { finishReason: 'completed', finalResponse: body, usage: null,
      requestedModel: { provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort ?? null, maxTokens: options.maxTokens },
      requestedPreset: 'minimal', observedPresets: ['minimal'], presetFingerprint: 'f'.repeat(64),
      observedRoutes: [{ provider: options.provider, model: options.model }], responseModels: [], dshVersion: '1.2.3',
      runtimeClosed: true, cleanupScope: 'sdk-runtime', durationMs: 1 } as DshRunResult;
  });
  const second = await createDshJudgeFromEnvironment(env, { run: roundTwoBadFirst }).review({ ...request, roundId: '2' });
  expect(second.verdict.dimensions.simplicity.score).toBe(78);
  expect(second.normalizations?.join('；')).toContain('第 2 轮第 1 次响应无效');
});

it('gives up after the per-round retry limit and does not silently accept a bad verdict', async () => {
  const { env } = fixture();
  let attempt = 0;
  const run: DshJudgeDependencies['run'] = vi.fn(async (options: DshRunOptions): Promise<DshRunResult> => {
    attempt += 1;
    return { finishReason: 'completed', finalResponse: '{"schemaVersion":"0.1.0","notes":["oops', usage: null,
      requestedModel: { provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort ?? null, maxTokens: options.maxTokens },
      requestedPreset: 'minimal', observedPresets: ['minimal'], presetFingerprint: 'f'.repeat(64),
      observedRoutes: [{ provider: options.provider, model: options.model }], responseModels: [], dshVersion: '1.2.3',
      runtimeClosed: true, cleanupScope: 'sdk-runtime', durationMs: 1 } as DshRunResult;
  });
  await expect(createDshJudgeFromEnvironment(env, { run }).review(request)).rejects.toThrow(/不是合法 JSON/);
  // 每轮最多两次会话：不会无限重试烧额度。
  expect(attempt).toBe(2);
});
it('accepts fenced JSON but rejects identity or evidence mismatches', async () => {
  const { env } = fixture();
  const run: DshJudgeDependencies['run'] = vi.fn(async (options: DshRunOptions): Promise<DshRunResult> => ({ finishReason: 'completed', finalResponse: '```json\n' + JSON.stringify(sampleVerdict(request, { simplicity: 1, maintainability: 1, decoupling: 1 }, ['candidate-1'], env.BENCH_JUDGE_DSH_MODEL, request.promptVersion)) + '\n```', usage: null,
    requestedModel: { provider: options.provider, model: options.model, reasoningEffort: null, maxTokens: options.maxTokens }, requestedPreset: 'minimal', observedPresets: ['minimal'], presetFingerprint: 'f'.repeat(64), observedRoutes: [{ provider: options.provider, model: options.model }], responseModels: [], dshVersion: '1.2.3', runtimeClosed: true, cleanupScope: 'sdk-runtime', durationMs: 1 }));
  const judge = createDshJudgeFromEnvironment(env, { run }); await expect(judge.review(request)).resolves.toBeDefined();
  await expect(judge.review({ ...request, materials: [{ id: 'only', kind: 'task', text: 'contract' }, { id: 'candidate-2', kind: 'candidate', text: 'source' }] })).rejects.toThrow('未提供');
});

it('accepts a valid verdict surrounded by short model commentary', async () => {
  const { env } = fixture();
  const run: DshJudgeDependencies['run'] = vi.fn(async (options: DshRunOptions): Promise<DshRunResult> => ({
    finishReason: 'completed',
    finalResponse: '评审结果如下：\n' + JSON.stringify(sampleVerdict(request, { simplicity: 80, maintainability: 80, decoupling: 80 }, ['candidate-1'], env.BENCH_JUDGE_DSH_MODEL, request.promptVersion)) + '\n以上。',
    usage: null,
    requestedModel: { provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort ?? null, maxTokens: options.maxTokens },
    requestedPreset: 'minimal', observedPresets: ['minimal'], presetFingerprint: 'f'.repeat(64),
    observedRoutes: [{ provider: options.provider, model: options.model }], responseModels: [], dshVersion: '1.2.3', runtimeClosed: true, cleanupScope: 'sdk-runtime', durationMs: 1,
  }));
  await expect(createDshJudgeFromEnvironment(env, { run }).review(request)).resolves.toMatchObject({ verdict: { model: env.BENCH_JUDGE_DSH_MODEL } });
});

it('accepts a verdict when the platform-owned fields are missing and records harmless decorations', async () => {
  const { env } = fixture();
  const modelVerdict = structuredClone(sampleVerdict(request, { simplicity: 70, maintainability: 60, decoupling: 80 }, ['candidate-1'], env.BENCH_JUDGE_DSH_MODEL, request.promptVersion)) as unknown as Record<string, unknown>;
  delete modelVerdict.cost; delete modelVerdict.reviewedAt;
  const dimensions = modelVerdict.dimensions as Record<string, unknown>;
  dimensions.simplicity = { score: 70, evidence: ['candidate-1', 'candidate-1'], note: '重复引用' };
  modelVerdict.summary = '总评';
  const run: DshJudgeDependencies['run'] = vi.fn(async (options: DshRunOptions): Promise<DshRunResult> => ({ finishReason: 'completed', finalResponse: JSON.stringify(modelVerdict), usage: null,
    requestedModel: { provider: options.provider, model: options.model, reasoningEffort: null, maxTokens: options.maxTokens }, requestedPreset: 'minimal', observedPresets: ['minimal'], presetFingerprint: 'f'.repeat(64), observedRoutes: [{ provider: options.provider, model: options.model }], responseModels: [], dshVersion: '1.2.3', runtimeClosed: true, cleanupScope: 'sdk-runtime', durationMs: 1 }));
  const outcome = await createDshJudgeFromEnvironment(env, { run }).review(request);
  expect(outcome.verdict.dimensions.simplicity.score).toBe(70);
  expect(outcome.verdict.dimensions.simplicity.evidence).toEqual(['candidate-1']);
  expect(outcome.verdict.cost).toEqual({ calls: 1, inputTokens: null, outputTokens: null });
  expect(outcome.verdict.reviewedAt).toBeTruthy();
  const normalizations = outcome.normalizations?.join(' ') ?? '';
  expect(normalizations).toContain('忽略未知字段 /summary');
  expect(normalizations).toContain('忽略未知字段 /dimensions/simplicity/note');
  expect(normalizations).toContain('去重证据 /dimensions/simplicity/evidence');
});

it('keeps the raw response and field paths when a verdict violates the protocol', async () => {
  const { env } = fixture();
  const sample = structuredClone(sampleVerdict(request, { simplicity: 70, maintainability: 60, decoupling: 80 }, ['candidate-1'], env.BENCH_JUDGE_DSH_MODEL, request.promptVersion)) as unknown as Record<string, unknown>;
  const sampleDimensions = sample.dimensions as Record<string, { score: number; evidence: string[] }>;
  sampleDimensions.simplicity = { score: 120, evidence: ['candidate-1'] };
  const broken = JSON.stringify(sample);
  const run: DshJudgeDependencies['run'] = vi.fn(async (options: DshRunOptions): Promise<DshRunResult> => ({ finishReason: 'completed', finalResponse: broken, usage: null,
    requestedModel: { provider: options.provider, model: options.model, reasoningEffort: null, maxTokens: options.maxTokens }, requestedPreset: 'minimal', observedPresets: ['minimal'], presetFingerprint: 'f'.repeat(64), observedRoutes: [{ provider: options.provider, model: options.model }], responseModels: [], dshVersion: '1.2.3', runtimeClosed: true, cleanupScope: 'sdk-runtime', durationMs: 1 }));
  const error = await createDshJudgeFromEnvironment(env, { run }).review(request).then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(JudgeProtocolError);
  expect((error as JudgeProtocolError).roundId).toBe('1');
  expect((error as JudgeProtocolError).rawResponse).toBe(broken);
  expect((error as JudgeProtocolError).issues.join(' ')).toContain('/dimensions/simplicity');
  expect((error as JudgeProtocolError).message).toContain('第 1 轮');
});

it('keeps the partial response when the review session does not finish', async () => {
  const { env } = fixture();
  const partial = '{"dimensions":{"simplicity":';
  const run: DshJudgeDependencies['run'] = vi.fn(async (options: DshRunOptions): Promise<DshRunResult> => ({ finishReason: 'timeout', finalResponse: partial, usage: null,
    requestedModel: { provider: options.provider, model: options.model, reasoningEffort: null, maxTokens: options.maxTokens }, requestedPreset: 'minimal', observedPresets: ['minimal'], presetFingerprint: 'f'.repeat(64), observedRoutes: [{ provider: options.provider, model: options.model }], responseModels: [], dshVersion: '1.2.3', runtimeClosed: true, cleanupScope: 'sdk-runtime', durationMs: 1 }));
  const error = await createDshJudgeFromEnvironment(env, { run }).review(request).then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(JudgeProtocolError);
  expect((error as JudgeProtocolError).rawResponse).toBe(partial);
  expect((error as JudgeProtocolError).message).toContain('未完成');
});

it('creates independent sessions for two rounds and refuses a third uncached call', async () => {
  const { env } = fixture(); const ids: string[] = [];
  const judge = createDshJudgeFromEnvironment(env, { run: async (options: DshRunOptions): Promise<DshRunResult> => { ids.push(options.sessionId); return { finishReason: 'completed', finalResponse: JSON.stringify(sampleVerdict(request, { simplicity: 1, maintainability: 1, decoupling: 1 }, ['candidate-1'], env.BENCH_JUDGE_DSH_MODEL, request.promptVersion)), usage: null, requestedModel: { provider: options.provider, model: options.model, reasoningEffort: null, maxTokens: options.maxTokens }, requestedPreset: 'minimal', observedPresets: ['minimal'], presetFingerprint: 'f'.repeat(64), observedRoutes: [{ provider: options.provider, model: options.model }], responseModels: [], dshVersion: '1.2.3', runtimeClosed: true, cleanupScope: 'sdk-runtime', durationMs: 1 }; } });
  await judge.review(request); await judge.review({ ...request, roundId: '2' }); expect(new Set(ids).size).toBe(2); await expect(judge.review({ ...request, roundId: '3' })).rejects.toThrow('两轮');
});