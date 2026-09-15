import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { sampleVerdict, type ReviewRequest } from '@fsa/judge';
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
    return { finishReason: 'completed', finalResponse: JSON.stringify(sampleVerdict(request, { simplicity: 80, maintainability: 70, decoupling: 90, performance: 60 }, ['candidate-1'], env.BENCH_JUDGE_DSH_MODEL, request.promptVersion)), usage: null,
      requestedModel: { provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort ?? null, maxTokens: options.maxTokens }, requestedPreset: 'minimal', observedPresets: ['minimal'], presetFingerprint: 'f'.repeat(64), observedRoutes: [{ provider: options.provider, model: options.model }], responseModels: [], dshVersion: '1.2.3', runtimeClosed: true, cleanupScope: 'sdk-runtime', durationMs: 1 };
  });
  const judge = createDshJudgeFromEnvironment(env, { run });
  const result = await judge.review(request);
  expect(result.verdict.dimensions.simplicity.score).toBe(80); expect(launches[0]!.workspacePermission).toBe('read-only'); expect(launches[0]!.reviewOnly).toBe(true);
  expect(result.inputTokens).toBeNull(); expect(result.configuration?.provider).toBe('dsh:deepseek-official');
});

it('accepts fenced JSON but rejects identity or evidence mismatches', async () => {
  const { env } = fixture();
  const run: DshJudgeDependencies['run'] = vi.fn(async (options: DshRunOptions): Promise<DshRunResult> => ({ finishReason: 'completed', finalResponse: '```json\n' + JSON.stringify(sampleVerdict(request, { simplicity: 1, maintainability: 1, decoupling: 1, performance: 1 }, ['candidate-1'], env.BENCH_JUDGE_DSH_MODEL, request.promptVersion)) + '\n```', usage: null,
    requestedModel: { provider: options.provider, model: options.model, reasoningEffort: null, maxTokens: options.maxTokens }, requestedPreset: 'minimal', observedPresets: ['minimal'], presetFingerprint: 'f'.repeat(64), observedRoutes: [{ provider: options.provider, model: options.model }], responseModels: [], dshVersion: '1.2.3', runtimeClosed: true, cleanupScope: 'sdk-runtime', durationMs: 1 }));
  const judge = createDshJudgeFromEnvironment(env, { run }); await expect(judge.review(request)).resolves.toBeDefined();
  await expect(judge.review({ ...request, materials: [{ id: 'only', kind: 'task', text: 'contract' }, { id: 'candidate-2', kind: 'candidate', text: 'source' }] })).rejects.toThrow('未提供');
});

it('accepts a valid verdict surrounded by short model commentary', async () => {
  const { env } = fixture();
  const run: DshJudgeDependencies['run'] = vi.fn(async (options: DshRunOptions): Promise<DshRunResult> => ({
    finishReason: 'completed',
    finalResponse: '评审结果如下：\n' + JSON.stringify(sampleVerdict(request, { simplicity: 80, maintainability: 80, decoupling: 80, performance: 80 }, ['candidate-1'], env.BENCH_JUDGE_DSH_MODEL, request.promptVersion)) + '\n以上。',
    usage: null,
    requestedModel: { provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort ?? null, maxTokens: options.maxTokens },
    requestedPreset: 'minimal', observedPresets: ['minimal'], presetFingerprint: 'f'.repeat(64),
    observedRoutes: [{ provider: options.provider, model: options.model }], responseModels: [], dshVersion: '1.2.3', runtimeClosed: true, cleanupScope: 'sdk-runtime', durationMs: 1,
  }));
  await expect(createDshJudgeFromEnvironment(env, { run }).review(request)).resolves.toMatchObject({ verdict: { model: env.BENCH_JUDGE_DSH_MODEL } });
});

it('creates independent sessions for two rounds and refuses a third uncached call', async () => {
  const { env } = fixture(); const ids: string[] = [];
  const judge = createDshJudgeFromEnvironment(env, { run: async (options: DshRunOptions): Promise<DshRunResult> => { ids.push(options.sessionId); return { finishReason: 'completed', finalResponse: JSON.stringify(sampleVerdict(request, { simplicity: 1, maintainability: 1, decoupling: 1, performance: 1 }, ['candidate-1'], env.BENCH_JUDGE_DSH_MODEL, request.promptVersion)), usage: null, requestedModel: { provider: options.provider, model: options.model, reasoningEffort: null, maxTokens: options.maxTokens }, requestedPreset: 'minimal', observedPresets: ['minimal'], presetFingerprint: 'f'.repeat(64), observedRoutes: [{ provider: options.provider, model: options.model }], responseModels: [], dshVersion: '1.2.3', runtimeClosed: true, cleanupScope: 'sdk-runtime', durationMs: 1 }; } });
  await judge.review(request); await judge.review({ ...request, roundId: '2' }); expect(new Set(ids).size).toBe(2); await expect(judge.review({ ...request, roundId: '3' })).rejects.toThrow('两轮');
});
