import { expect, it } from 'vitest';
import { maskedConfigView, missingGroups, redactStream, secretKeyPattern, secretValues, validateConfigPatch } from './config.ts';

const digest = 'sha256:' + 'a'.repeat(64);
const basic = { BENCH_RUN_TOKEN: 'local-token', BENCH_SUBMISSIONS_DIR: 'answers', BENCH_PROFILE: 'local' };
const judge = { BENCH_JUDGE_ENDPOINT: 'https://judge.invalid/v1', BENCH_JUDGE_MODEL: 'fixture-model', BENCH_JUDGE_TOKEN: 'fixture-key' };

it('缺失分组沿用原有四组判定，不写文件也不调用模型', () => {
  expect(missingGroups({})).toEqual(['基础运行配置', '裁判配置']);
  expect(missingGroups({ ...basic, ...judge })).toEqual([]);
  expect(missingGroups({ ...basic, BENCH_PROFILE: 'linux-container', BENCH_IMAGE: digest })).toEqual(['固定 Linux 镜像', '裁判配置']);
  expect(missingGroups({ ...basic, BENCH_PROFILE: 'linux-container', BENCH_IMAGE: digest, BENCH_IMAGE_DIGEST: digest })).toEqual(['裁判配置']);
  // 有 DSH root/home 时改判 DSH 评分 Agent 配置，普通裁判键不再适用（沿用迁移前的判定顺序）。
  expect(missingGroups({ ...basic, BENCH_DSH_ROOT: 'dsh', BENCH_DSH_HOME: 'home', ...judge })).toEqual(['DSH 工作区权限', '裁判配置']);
  expect(missingGroups({ ...basic, BENCH_DSH_ROOT: 'dsh', BENCH_DSH_HOME: 'home', BENCH_DSH_WORKSPACE_PERMISSION: 'workspace-write',
    BENCH_JUDGE_DSH_PROVIDER: 'p', BENCH_JUDGE_DSH_MODEL: 'm' })).toEqual([]);
  expect(missingGroups({ ...basic, BENCH_RUN_TOKEN: '   ', ...judge })).toEqual(['基础运行配置']);
});

it('字段级校验返回出错字段，不抛一个大异常', () => {
  expect(validateConfigPatch({}, { ...judge })).toEqual([]);
  expect(validateConfigPatch({}, { BENCH_PROFILE: 'container' })).toEqual([{ field: 'BENCH_PROFILE', message: '必须是 local 或 linux-container。' }]);
  expect(validateConfigPatch({}, { BENCH_IMAGE: 'latest' })).toEqual([{ field: 'BENCH_IMAGE', message: '必须是 sha256: 加 64 位小写十六进制摘要。' }]);
  expect(validateConfigPatch({}, { BENCH_JUDGE_MAX_CALLS: '0' })).toEqual([{ field: 'BENCH_JUDGE_MAX_CALLS', message: '必须是正整数。' }]);
  expect(validateConfigPatch({}, { 'BAD NAME': 'x' })[0]!.field).toBe('BAD NAME');
  expect(validateConfigPatch({}, { BENCH_RUN_DIR: 'bad\u0007dir' })).toEqual([{ field: 'BENCH_RUN_DIR', message: '值不能包含控制字符。' }]);
  expect(validateConfigPatch({}, { BENCH_DSH_HOME: '~/dsh' })).toEqual([{ field: 'BENCH_DSH_HOME', message: '不支持 ~ 展开，请填写完整路径。' }]);
  expect(validateConfigPatch({}, { BENCH_RUN_DIR: 'data/runs' }, { baseDirectory: process.cwd() })).toEqual([]);
  expect(validateConfigPatch({}, { BENCH_PROFILE: 'local', BENCH_JUDGE_ENDPOINT: 'not a url', BENCH_JUDGE_MODEL: 'm', BENCH_JUDGE_TOKEN: 't' })[0]!.field).toBe('BENCH_JUDGE_*');
});

it('裁判相关校验复用 @fsa/evaluation 的 DSH 选项检查', () => {
  const dsh = { BENCH_DSH_ROOT: 'dsh-root', BENCH_DSH_HOME: 'dsh-home' };
  expect(validateConfigPatch({}, { ...dsh, BENCH_JUDGE_DSH_PROVIDER: 'p', BENCH_JUDGE_DSH_MODEL: 'm' })).toEqual([]);
  const errors = validateConfigPatch({}, { ...dsh, BENCH_JUDGE_DSH_PROVIDER: 'p' });
  expect(errors).toHaveLength(1); expect(errors[0]!.field).toBe('BENCH_JUDGE_*');
  expect(errors[0]!.message).toContain('BENCH_JUDGE_DSH_MODEL');
});

it('遮蔽视图只暴露密钥键是否已配置，并按merge语义标记被OS环境覆盖的键', () => {
  const view = maskedConfigView({ BENCH_RUN_TOKEN: 'os-token', BENCH_PROFILE: 'local' },
    { BENCH_RUN_TOKEN: 'file-token', BENCH_PROFILE: 'linux-container', BENCH_JUDGE_TOKEN: 'file-key', CUSTOM: 'kept' });
  expect(view.BENCH_RUN_TOKEN).toEqual({ configured: true, source: 'environment', shadowed: true });
  expect(view.BENCH_JUDGE_TOKEN).toEqual({ configured: true, source: 'file', shadowed: false });
  expect(view.BENCH_PROFILE).toEqual({ value: 'local', source: 'environment', shadowed: true });
  expect(view.CUSTOM).toEqual({ value: 'kept', source: 'file', shadowed: false });
  expect(JSON.stringify(view)).not.toContain('os-token');
  expect(JSON.stringify(view)).not.toContain('file-token');
  expect(JSON.stringify(view)).not.toContain('file-key');
  const environmentOnly = maskedConfigView({ BENCH_RUN_DIR: 'runs' }, {});
  expect(environmentOnly.BENCH_RUN_DIR).toEqual({ value: 'runs', source: 'environment', shadowed: false });
  const blank = maskedConfigView({ BENCH_JUDGE_TOKEN: '   ' }, { BENCH_JUDGE_TOKEN: '' });
  expect(blank.BENCH_JUDGE_TOKEN).toEqual({ configured: false, source: 'file', shadowed: false });
});

it('密钥键判定与取值只依赖键名和值是否非空', () => {
  expect(secretKeyPattern.test('BENCH_JUDGE_TOKEN')).toBe(true);
  expect(secretKeyPattern.test('BENCH_RUN_TOKEN')).toBe(true);
  expect(secretKeyPattern.test('SOME_API_KEY')).toBe(true);
  expect(secretKeyPattern.test('DB_PASSWORD')).toBe(true);
  expect(secretKeyPattern.test('CLIENT_SECRET')).toBe(true);
  expect(secretKeyPattern.test('BENCH_SUBMISSIONS_DIR')).toBe(false);
  expect(secretValues({ BENCH_JUDGE_TOKEN: 'a', BENCH_RUN_TOKEN: '   ', API_KEY: 'b', BENCH_PROFILE: 'local' })).toEqual(['a', 'b']);
});

it('脱敏流跨chunk边界替换密钥，flush后不残留尾部', () => {
  const secret = 'super-secret-token-value';
  const text = `before ${secret} after and ${secret} again`;
  const stream = redactStream([secret, '']);
  let output = '';
  for (const character of text) output += stream.push(character);
  output += stream.flush();
  expect(output).toBe('before [已隐藏] after and [已隐藏] again');
  expect(output).not.toContain(secret);
  const whole = redactStream([secret]);
  expect(whole.push(text) + whole.flush()).toBe('before [已隐藏] after and [已隐藏] again');
  // 尾部半截前缀不算密钥；补全后必须整体替换，不能把前一半先漏出去。
  const split = redactStream([secret]);
  expect(split.push('log ' + secret.slice(0, 8))).toBe('log ');
  expect(split.push(secret.slice(8) + ' end') + split.flush()).toBe('[已隐藏] end');
  const overlapping = redactStream(['abcd', 'abcde']);
  expect(overlapping.push('xabcdey') + overlapping.flush()).toBe('x[已隐藏]y');
  const clean = redactStream([]);
  expect(clean.push('plain text') + clean.flush()).toBe('plain text');
});
