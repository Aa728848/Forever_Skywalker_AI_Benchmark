import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import type { DshModelCatalog } from '../../../packages/evaluation/src/dsh-catalog.ts';
import { collectDshJudgeSetup, configureDshJudgeFromTerminal } from './judge-dsh-setup.ts';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    const target = resolve(root);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('fsa-judge-dsh-')) throw new Error('测试临时目录越界。');
    rmSync(target, { recursive: true, force: true });
  }
});

function fixture(answers: string[]) {
  const output: string[] = [];
  const asked: string[] = [];
  return { output, asked, io: {
    say: (message: string) => { output.push(message); },
    ask: async (prompt: string) => { asked.push(prompt); return answers.shift() ?? null; },
  } };
}

const catalog: DshModelCatalog = { warning: null, providers: [
  { id: 'gateway-a', name: 'A', models: [{ id: 'fixture-model', name: 'Fixture', reasoningEfforts: ['low', 'high'] }] },
  { id: 'gateway-b', name: 'B', models: [{ id: 'other-model', name: 'Other', reasoningEfforts: [] }] },
] };
const baseEnv = { BENCH_DSH_ROOT: 'C:/dsh-root', BENCH_DSH_HOME: 'C:/dsh-home' };
const completeEnv = { ...baseEnv, BENCH_JUDGE_DSH_PROVIDER: 'gateway-a', BENCH_JUDGE_DSH_MODEL: 'fixture-model',
  BENCH_JUDGE_DSH_REASONING_EFFORT: 'high', BENCH_JUDGE_DSH_MAX_TOKENS: '16384', BENCH_JUDGE_DSH_TIMEOUT_MS: '300000', BENCH_JUDGE_PROMPT_VERSION: 'dsh-review-v1' };

it('空配置按本地目录选择供应商、模型与思考等级，并补齐预算默认值', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不能请求网络'));
  const context = fixture(['1', '', '1', '3', '', '', '']);
  const updates = await collectDshJudgeSetup(context.io, baseEnv, { discover: async () => catalog });
  expect(updates).toEqual({
    BENCH_JUDGE_DSH_PROVIDER: 'gateway-a', BENCH_JUDGE_DSH_MODEL: 'fixture-model', BENCH_JUDGE_DSH_REASONING_EFFORT: 'high',
    BENCH_JUDGE_DSH_MAX_TOKENS: '16384', BENCH_JUDGE_DSH_TIMEOUT_MS: '300000', BENCH_JUDGE_PROMPT_VERSION: 'dsh-review-v1',
  });
  expect(context.output.join('\n')).toContain('参数检查通过');
  expect(context.output.join('\n')).toContain('gateway-a / fixture-model');
  expect(network).not.toHaveBeenCalled();
});

it('目录不可用时手工填写供应商与模型，等级沿用默认', async () => {
  const context = fixture(['', 'custom-provider', 'custom-model', '', '', '', '']);
  const updates = await collectDshJudgeSetup(context.io, baseEnv, { discover: async () => ({ providers: [], warning: '未读到本地目录，请手工填写。' }) });
  expect(updates).toMatchObject({ BENCH_JUDGE_DSH_PROVIDER: 'custom-provider', BENCH_JUDGE_DSH_MODEL: 'custom-model', BENCH_JUDGE_DSH_REASONING_EFFORT: 'default' });
  expect(context.output.join('\n')).toContain('未读到本地目录');
});

it('已完整配置且不覆写时不读目录、不提问', async () => {
  const context = fixture([]);
  const discover = vi.fn(async () => catalog);
  expect(await collectDshJudgeSetup(context.io, completeEnv, { discover })).toEqual({});
  expect(discover).not.toHaveBeenCalled();
  expect(context.asked).toEqual([]);
  expect(context.output.join('\n')).toContain('已配置');
});

it('覆写模式以现有值作默认重新选择并返回全部字段', async () => {
  const context = fixture(['', '', '', '', '', '', '']);
  const updates = await collectDshJudgeSetup(context.io, completeEnv, { replace: true, discover: async () => catalog });
  expect(updates).toEqual({
    BENCH_JUDGE_DSH_PROVIDER: 'gateway-a', BENCH_JUDGE_DSH_MODEL: 'fixture-model', BENCH_JUDGE_DSH_REASONING_EFFORT: 'high',
    BENCH_JUDGE_DSH_MAX_TOKENS: '16384', BENCH_JUDGE_DSH_TIMEOUT_MS: '300000', BENCH_JUDGE_PROMPT_VERSION: 'dsh-review-v1',
  });
});

it('已有但无效的非空值会被重新询问，不因“已填写”而放行', async () => {
  const context = fixture(['', '', '', '2', '', '', '']);
  const env = { ...completeEnv, BENCH_JUDGE_DSH_REASONING_EFFORT: 'INVALID' };
  const updates = await collectDshJudgeSetup(context.io, env, { discover: async () => catalog });
  expect(updates?.BENCH_JUDGE_DSH_REASONING_EFFORT).toBe('low');
  expect(context.output.join('\n')).toContain('未通过检查');
});

it('取消输入不返回可保存项，也不修改调用方环境', async () => {
  const context = fixture(['q']);
  const env = { ...baseEnv };
  expect(await collectDshJudgeSetup(context.io, env, { discover: async () => catalog })).toBeNull();
  expect(env).toEqual(baseEnv);
  expect(context.output.join('\n')).toContain('已取消裁判模型设置');
});

it('独立命令确认后覆写已有裁判模型并保留注释与其它键', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fsa-judge-dsh-')); roots.push(root);
  const original = '# 保留注释\nBENCH_DSH_ROOT=C:/dsh-root\nBENCH_DSH_HOME=C:/dsh-home\n'
    + 'BENCH_JUDGE_DSH_PROVIDER=old-provider\nBENCH_JUDGE_DSH_MODEL=old-model\nBENCH_JUDGE_DSH_REASONING_EFFORT=high\n'
    + 'BENCH_JUDGE_DSH_MAX_TOKENS=16384\nBENCH_JUDGE_DSH_TIMEOUT_MS=300000\nBENCH_JUDGE_PROMPT_VERSION=dsh-review-v1\nCUSTOM=kept\n';
  writeFileSync(join(root, '.env'), original);
  const context = fixture(['', '', '', '', '', '', '', 'y']);
  const outcome = await configureDshJudgeFromTerminal(context.io, { root, env: {}, discover: async () => catalog });
  expect(outcome.saved).toBe(true);
  const saved = parseEnv(readFileSync(join(root, '.env'), 'utf8'));
  expect(saved).toMatchObject({ BENCH_JUDGE_DSH_PROVIDER: 'gateway-a', BENCH_JUDGE_DSH_MODEL: 'fixture-model', CUSTOM: 'kept', BENCH_DSH_HOME: 'C:/dsh-home' });
  expect(readFileSync(join(root, '.env'), 'utf8').startsWith('# 保留注释\n')).toBe(true);
  expect(outcome.env.BENCH_JUDGE_DSH_PROVIDER).toBe('gateway-a');
});

it('未确认写入时 .env 保持原样，缺少 DSH 目录时提前拒绝', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fsa-judge-dsh-')); roots.push(root);
  const original = 'BENCH_DSH_ROOT=C:/dsh-root\nBENCH_DSH_HOME=C:/dsh-home\nBENCH_JUDGE_DSH_PROVIDER=old-provider\nBENCH_JUDGE_DSH_MODEL=old-model\n';
  writeFileSync(join(root, '.env'), original);
  const declined = fixture(['', '', '', '', '', '', '', 'n']);
  expect(await configureDshJudgeFromTerminal(declined.io, { root, env: {}, discover: async () => catalog })).toMatchObject({ saved: false, cancelled: true });
  expect(readFileSync(join(root, '.env'), 'utf8')).toBe(original);
  const bare = mkdtempSync(join(tmpdir(), 'fsa-judge-dsh-')); roots.push(bare);
  const missing = fixture([]);
  expect(await configureDshJudgeFromTerminal(missing.io, { root: bare, env: {}, discover: async () => { throw new Error('不应读取目录'); } })).toMatchObject({ saved: false, cancelled: true });
  expect(missing.output.join('\n')).toContain('BENCH_DSH_ROOT');
});
