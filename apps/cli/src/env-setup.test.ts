import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { configureProjectEnvironment } from './env-setup.ts';

const roots: string[] = [];
function setup(answers: string[], token = 'fixture-only-token') {
  const root = mkdtempSync(join(tmpdir(), 'fsa-env-setup-')); roots.push(root);
  const output: string[] = [];
  return { root, output, io: {
    say: (message: string) => { output.push(message); },
    ask: async (_prompt: string) => answers.shift() ?? null,
    secret: async (_prompt: string) => token,
  } };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    const target = resolve(root);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('fsa-env-setup-')) throw new Error('临时目录越界');
    rmSync(target, { recursive: true, force: true });
  }
});

it('空环境复用已记录Linux镜像、生成本地令牌，确认保存后当前进程立即可用', async () => {
  const context = setup(['', '', '', '', '2', '', '2', '']);
  const digest = 'sha256:' + 'a'.repeat(64);
  mkdirSync(join(context.root, 'data', 'container'), { recursive: true });
  writeFileSync(join(context.root, 'data', 'container', 'runtime.json'), JSON.stringify({ image: digest, imageDigest: digest }));
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不应调用网络'));
  const result = await configureProjectEnvironment(context.io, { root: context.root, env: {} });
  expect(result).toMatchObject({ saved: true, cancelled: false, env: { BENCH_PROFILE: 'linux-container', BENCH_IMAGE: digest, BENCH_IMAGE_DIGEST: digest } });
  expect(result.env.BENCH_RUN_TOKEN).toMatch(/^[a-f0-9]{64}$/);
  expect(context.output.join('\n')).not.toContain(result.env.BENCH_RUN_TOKEN);
  expect(parseEnv(readFileSync(join(context.root, '.env'), 'utf8')).BENCH_RUN_TOKEN).toBe(result.env.BENCH_RUN_TOKEN);
  expect(context.output.join('\n')).toContain('仍待配置：裁判配置');
  expect(network).not.toHaveBeenCalled();
});

it.each(['q', '2'])('取消或放弃保存时不创建.env，内存中的生成令牌也不应用（%s）', async final => {
  const context = setup(['', '', '', '2', '2', '', '2', final]);
  const result = await configureProjectEnvironment(context.io, { root: context.root, env: {} });
  expect(result.saved).toBe(false); expect(result.env.BENCH_RUN_TOKEN).toBeUndefined();
  expect(existsSync(join(context.root, '.env'))).toBe(false);
});

it('补齐现有文件的裁判密钥不覆盖既有配置，摘要不泄露密钥且子进程环境取得新值', async () => {
  const token = 'fixture#token$() " with \\slashes';
  const context = setup(['', '1', ''], token);
  const values = {
    BENCH_RUN_TOKEN: 'retained-local-token', BENCH_SUBMISSIONS_DIR: 'existing-answers', BENCH_RUN_DIR: 'existing-runs', BENCH_PROFILE: 'local',
    BENCH_DSH_ROOT: 'existing-dsh', BENCH_DSH_HOME: 'existing-home', BENCH_DSH_REPORT_DIR: 'existing-reports', BENCH_MEASURE_PERFORMANCE: '1',
    BENCH_JUDGE_PROVIDER: 'openai-compatible', BENCH_JUDGE_ENDPOINT: 'https://judge.invalid/v1', BENCH_JUDGE_MODEL: 'fixture-model', BENCH_JUDGE_TOKEN: '',
    BENCH_JUDGE_REASONING_EFFORT: 'high', BENCH_JUDGE_MAX_CALLS: '2', BENCH_JUDGE_MAX_INPUT_TOKENS: '60000', BENCH_JUDGE_MAX_OUTPUT_TOKENS: '4000',
    BENCH_JUDGE_MAX_TOKENS_PER_CALL: '2000', BENCH_JUDGE_TIMEOUT_MS: '60000',
  };
  const before = '# 用户已有注释\nCUSTOM=kept\n' + Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
  writeFileSync(join(context.root, '.env'), before);
  const result = await configureProjectEnvironment(context.io, { root: context.root, env: { BENCH_RUN_TOKEN: 'shell-override' } });
  const after = readFileSync(join(context.root, '.env'), 'utf8');
  expect(result.saved).toBe(true); expect(result.env.BENCH_JUDGE_TOKEN).toBe(token);
  expect(result.env.BENCH_RUN_TOKEN).toBe('shell-override');
  expect(parseEnv(after)).toMatchObject({ ...values, CUSTOM: 'kept', BENCH_JUDGE_TOKEN: token });
  expect(after.startsWith('# 用户已有注释\n')).toBe(true);
  expect(context.output.join('\n')).not.toContain(token);
});

it('已有基础和有效裁判时自动启动不重复询问或改写文件', async () => {
  const context = setup([]);
  const file = 'CUSTOM=untouched\n'; writeFileSync(join(context.root, '.env'), file);
  const env = { BENCH_RUN_TOKEN: 'from-shell', BENCH_SUBMISSIONS_DIR: 'answers', BENCH_PROFILE: 'local',
    BENCH_JUDGE_ENDPOINT: 'https://judge.invalid', BENCH_JUDGE_MODEL: 'fixture-model', BENCH_JUDGE_TOKEN: 'from-shell-judge' };
  const result = await configureProjectEnvironment(context.io, { root: context.root, env });
  expect(result).toMatchObject({ saved: false, cancelled: false });
  expect(context.output).toEqual([]); expect(readFileSync(join(context.root, '.env'), 'utf8')).toBe(file);
});
