import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exportWorkspace } from '../../../packages/tasks/src/index.ts';
import { buildApp } from './app.ts';

/**
 * 配置路由测试。
 * 全部使用系统临时目录作为项目根：测试绝不读写用户真实的 .env，
 * 且 configEnv 显式注入最小环境，避免把当前进程的环境变量混进断言。
 */

const judgeToken = 'probe-judge-token-9f3a';
const runToken = 'probe-run-token-7c1e';

const roots: string[] = [];

function scratchRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), 'fsa-config-test-'));
  roots.push(directory);
  return directory;
}

/** 用真实的 .env 文本建项目根：保留换行形式，便于断言原样保留。 */
function projectRoot(text: string): string {
  const root = scratchRoot();
  writeFileSync(join(root, '.env'), text);
  return root;
}

afterEach(() => {
  for (const directory of roots.splice(0)) {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('fsa-config-test-')) throw new Error('临时目录不在测试范围内。');
    rmSync(target, { recursive: true, force: true });
  }
});

const baseEnvFile = [
  '# 保留注释：这一行必须原样存在',
  `BENCH_RUN_TOKEN=${runToken}`,
  `BENCH_JUDGE_TOKEN=${judgeToken}`,
  'BENCH_JUDGE_ENDPOINT=https://judge.invalid/v1',
  'BENCH_JUDGE_MODEL=judge-model',
  'BENCH_DSH_PROVIDER=deepseek-official',
  'BENCH_DSH_MODEL=old-model',
  'CUSTOM_UNKNOWN_KEY=kept-as-is',
  '',
].join('\n');

describe('配置读取（掩码视图）', () => {
  it('掩码视图不包含任何密钥值，密钥键只给出 configured', async () => {
    const root = projectRoot(baseEnvFile);
    const app = buildApp(':memory:', { configRoot: root, configEnv: {} });
    try {
      const response = await app.inject('/api/config');
      expect(response.statusCode).toBe(200);
      // 最强形式的断言：整个响应正文里都不出现密钥值。
      expect(response.body).not.toContain(judgeToken);
      expect(response.body).not.toContain(runToken);
      const view = response.json();
      // 密钥键：可写（轮换令牌），但只给 configured，永远不给 value。
      expect(view.entries.BENCH_JUDGE_TOKEN).toMatchObject({ configured: true, source: 'file', shadowed: false, writable: true });
      expect(Object.hasOwn(view.entries.BENCH_JUDGE_TOKEN, 'value')).toBe(false);
      expect(view.entries.BENCH_RUN_TOKEN).toMatchObject({ configured: true, writable: true });
      expect(Object.hasOwn(view.entries.BENCH_RUN_TOKEN, 'value')).toBe(false);
      // 非密钥键照常回显值；只读项标注 writable: false 与原因。
      expect(view.entries.BENCH_DSH_MODEL).toMatchObject({ value: 'old-model', writable: true, readOnlyReason: null });
      expect(view.entries.BENCH_RUN_DIR.writable).toBe(false);
      expect(String(view.entries.BENCH_RUN_DIR.readOnlyReason)).toContain('重启');
      expect(view.path).toBe(join(resolve(root), '.env'));
    } finally { await app.close(); }
  });

  it('保存响应与待写清单同样不泄漏密钥值', async () => {
    const root = projectRoot(baseEnvFile);
    const app = buildApp(':memory:', { configRoot: root, configEnv: {} });
    try {
      const pending = await app.inject({ method: 'POST', url: '/api/config', headers: { 'x-bench-token': runToken }, payload: { patch: { BENCH_JUDGE_TOKEN: 'rotated-secret-abcd', BENCH_DSH_MODEL: 'new-model' } } });
      expect(pending.statusCode).toBe(200);
      expect(pending.body).not.toContain('rotated-secret-abcd');
      expect(pending.body).not.toContain(judgeToken);
      const plan = pending.json();
      expect(plan.confirmRequired).toBe(true);
      expect(plan.plan.secrets).toEqual([{ field: 'BENCH_JUDGE_TOKEN', text: '已填写' }]);
      expect(plan.plan.fields).toEqual([{ field: 'BENCH_DSH_MODEL', value: 'new-model' }]);

      const saved = await app.inject({ method: 'POST', url: '/api/config', headers: { 'x-bench-token': runToken }, payload: { patch: { BENCH_JUDGE_TOKEN: 'rotated-secret-abcd' }, confirm: true } });
      expect(saved.statusCode).toBe(200);
      expect(saved.body).not.toContain('rotated-secret-abcd');
      expect(saved.body).not.toContain(judgeToken);
      expect(saved.json().view.entries.BENCH_JUDGE_TOKEN).toMatchObject({ configured: true });
      // 只有 .env 真的拿到新值，响应里才永远看不到它。
      expect(readFileSync(join(root, '.env'), 'utf8')).toContain('rotated-secret-abcd');
    } finally { await app.close(); }
  });

  it('遮蔽：.env 有非空值但被非空 OS 环境变量覆盖时 shadowed 为 true 并给出环境值', async () => {
    const root = projectRoot(baseEnvFile);
    const app = buildApp(':memory:', { configRoot: root, configEnv: { BENCH_DSH_PROVIDER: 'from-os', BENCH_DSH_MODEL: '' } });
    try {
      const view = (await app.inject('/api/config')).json();
      expect(view.entries.BENCH_DSH_PROVIDER).toMatchObject({ value: 'from-os', source: 'environment', shadowed: true });
      // trim 后为空的 OS 变量不遮蔽 .env（与 env-file.ts 的 merge() 一致）。
      expect(view.entries.BENCH_DSH_MODEL).toMatchObject({ value: 'old-model', source: 'file', shadowed: false });

      // 保存 .env 之后仍然被环境变量覆盖：响应里的 shadowed 必须保持 true，前端据此继续警告。
      const saved = await app.inject({ method: 'POST', url: '/api/config', headers: { 'x-bench-token': runToken }, payload: { patch: { BENCH_DSH_PROVIDER: 'written-to-file' }, confirm: true } });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().view.entries.BENCH_DSH_PROVIDER).toMatchObject({ value: 'from-os', source: 'environment', shadowed: true });
      expect(readFileSync(join(root, '.env'), 'utf8')).toContain('BENCH_DSH_PROVIDER=written-to-file');
    } finally { await app.close(); }
  });

  it('裁判 DSH 字段：已配置 DSH 目录时正常保存（真实部署路径）', async () => {
    const root = projectRoot(baseEnvFile + 'BENCH_DSH_ROOT=C:/dsh-root\nBENCH_DSH_HOME=C:/dsh-home\n');
    const path = join(root, '.env');
    const app = buildApp(':memory:', { configRoot: root, configEnv: {} });
    try {
      const patch = { BENCH_JUDGE_DSH_PROVIDER: 'deepseek-official', BENCH_JUDGE_DSH_MODEL: 'deepseek-v4-pro', BENCH_JUDGE_DSH_REASONING_EFFORT: 'high', BENCH_JUDGE_DSH_MAX_TOKENS: '16384', BENCH_JUDGE_DSH_TIMEOUT_MS: '300000', BENCH_JUDGE_PROMPT_VERSION: 'dsh-review-v1' };
      const response = await app.inject({ method: 'POST', url: '/api/config', headers: { 'x-bench-token': runToken }, payload: { patch, confirm: true } });
      expect(response.statusCode).toBe(200);
      expect(response.json().changedKeys).toEqual(Object.keys(patch));
      const after = readFileSync(path, 'utf8');
      for (const [key, value] of Object.entries(patch)) expect(after).toContain(`${key}=${value}`);
      expect(after).toContain('# 保留注释：这一行必须原样存在');
      // 同一进程内 /api/health 立即按新配置报告裁判已就绪：证明按操作求值，无需重启。
      expect((await app.inject('/api/health')).json()).toMatchObject({ judgeConfigured: true });
    } finally { await app.close(); }
  });

  it('已知约束：未配置 DSH 目录时，@fsa/config 会把 DSH 裁判字段判为未知配置项（packages/config 既有行为）', async () => {
    // 这不是本路由的设计目标，而是 validateConfigPatch -> judgeConfigFromEnvironment 的既有行为：
    // 没有 BENCH_DSH_ROOT/HOME 时会退回 HTTP 裁判校验，而它不认 BENCH_JUDGE_DSH_* 键。
    // 本测试把这个事实固定下来，避免以后误以为裁判字段「静默可写」。
    const root = projectRoot(baseEnvFile);
    const path = join(root, '.env');
    const before = readFileSync(path);
    const app = buildApp(':memory:', { configRoot: root, configEnv: {} });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/config', headers: { 'x-bench-token': runToken }, payload: { patch: { BENCH_JUDGE_DSH_PROVIDER: 'deepseek-official', BENCH_JUDGE_DSH_MODEL: 'deepseek-v4-pro' }, confirm: true } });
      expect(response.statusCode).toBe(400);
      expect(response.json().errors[0].field).toBe('BENCH_JUDGE_*');
      expect(readFileSync(path)).toEqual(before);
    } finally { await app.close(); }
  });

  it('模型目录读取失败返回空目录与原因，而不是 500', async () => {
    const root = projectRoot(baseEnvFile);
    const app = buildApp(':memory:', { configRoot: root, configEnv: { BENCH_DSH_ROOT: join(root, 'missing-dsh'), BENCH_DSH_HOME: join(root, 'missing-home'), BENCH_DSH_PROFILE: 'sdk' } });
    try {
      const response = await app.inject('/api/config/models');
      expect(response.statusCode).toBe(200);
      const catalog = response.json();
      expect(catalog.providers).toEqual([]);
      expect(catalog.warning).toContain('手工填写');
    } finally { await app.close(); }
  }, 30_000);
});

describe('配置写入', () => {
  it('无令牌 401，有令牌通过，且 401 时不写文件', async () => {
    const root = projectRoot(baseEnvFile);
    const path = join(root, '.env');
    const before = readFileSync(path);
    const app = buildApp(':memory:', { configRoot: root, configEnv: {} });
    try {
      const anonymous = await app.inject({ method: 'POST', url: '/api/config', payload: { patch: { BENCH_DSH_MODEL: 'blocked-model' }, confirm: true } });
      expect(anonymous.statusCode).toBe(401);
      expect(readFileSync(path)).toEqual(before);

      const wrong = await app.inject({ method: 'POST', url: '/api/config', headers: { 'x-bench-token': 'wrong-token' }, payload: { patch: { BENCH_DSH_MODEL: 'blocked-model' }, confirm: true } });
      expect(wrong.statusCode).toBe(401);
      expect(readFileSync(path)).toEqual(before);

      const allowed = await app.inject({ method: 'POST', url: '/api/config', headers: { 'x-bench-token': runToken }, payload: { patch: { BENCH_DSH_MODEL: 'allowed-model' }, confirm: true } });
      expect(allowed.statusCode).toBe(200);
      expect(readFileSync(path, 'utf8')).toContain('BENCH_DSH_MODEL=allowed-model');
    } finally { await app.close(); }
  });

  it('校验失败返回字段级错误且不写文件（.env 字节不变）', async () => {
    const root = projectRoot(baseEnvFile);
    const path = join(root, '.env');
    const before = readFileSync(path);
    const app = buildApp(':memory:', { configRoot: root, configEnv: {} });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/config', headers: { 'x-bench-token': runToken }, payload: { patch: { BENCH_JUDGE_DSH_TIMEOUT_MS: '-5', BENCH_DSH_MODEL: 'would-be-model' }, confirm: true } });
      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.errors).toEqual([{ field: 'BENCH_JUDGE_DSH_TIMEOUT_MS', message: '必须是正整数。' }]);
      expect(readFileSync(path)).toEqual(before);

      const typed = await app.inject({ method: 'POST', url: '/api/config', headers: { 'x-bench-token': runToken }, payload: { patch: { BENCH_DSH_MODEL: 42 }, confirm: true } });
      expect(typed.statusCode).toBe(400);
      expect(typed.json().errors[0].field).toBe('BENCH_DSH_MODEL');
      expect(readFileSync(path)).toEqual(before);
    } finally { await app.close(); }
  });

  it('只改被编辑的字段：注释、未知键与 CRLF 原样保留', async () => {
    const text = [
      '# 顶部注释',
      'BENCH_DSH_PROVIDER=deepseek-official  # 行尾注释',
      `BENCH_RUN_TOKEN=${runToken}`,
      'BENCH_DSH_MODEL=old-model',
      'CUSTOM_UNKNOWN_KEY=kept-as-is',
      '',
    ].join('\r\n');
    const root = projectRoot(text);
    const path = join(root, '.env');
    const app = buildApp(':memory:', { configRoot: root, configEnv: {} });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/config', headers: { 'x-bench-token': runToken }, payload: { patch: { BENCH_DSH_MODEL: 'new-model' }, confirm: true } });
      expect(response.statusCode).toBe(200);
      const after = readFileSync(path, 'utf8');
      expect(after).toContain('BENCH_DSH_MODEL=new-model');
      expect(after).toContain('# 顶部注释');
      expect(after).toContain('BENCH_DSH_PROVIDER=deepseek-official  # 行尾注释');
      expect(after).toContain('CUSTOM_UNKNOWN_KEY=kept-as-is');
      expect(after).toContain(`BENCH_RUN_TOKEN=${runToken}`);
      // 只替换了模型那一处：行数与其它字节都保持不变。
      expect(after.split('\r\n').length).toBe(text.split('\r\n').length);
      expect(after.replace('new-model', 'old-model')).toBe(text);
      expect(response.json().changedKeys).toEqual(['BENCH_DSH_MODEL']);
    } finally { await app.close(); }
  });

  it('新键只被追加，既有赋值不被触碰；清空既有非空值被明确拒绝而非静默跳过', async () => {
    const root = projectRoot(baseEnvFile);
    const path = join(root, '.env');
    const before = readFileSync(path);
    const app = buildApp(':memory:', { configRoot: root, configEnv: {} });
    try {
      const rejected = await app.inject({ method: 'POST', url: '/api/config', headers: { 'x-bench-token': runToken }, payload: { patch: { BENCH_MEASURE_PERFORMANCE: '1', BENCH_DSH_MODEL: '' }, confirm: true } });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json().errors).toEqual([{ field: 'BENCH_DSH_MODEL', message: '不支持通过网页清空既有非空配置；请在 CLI 或 .env 中手动删除该行。' }]);
      expect(readFileSync(path)).toEqual(before);

      const appended = await app.inject({ method: 'POST', url: '/api/config', headers: { 'x-bench-token': runToken }, payload: { patch: { BENCH_MEASURE_PERFORMANCE: '1' }, confirm: true } });
      expect(appended.statusCode).toBe(200);
      const after = readFileSync(path, 'utf8');
      expect(after).toContain('BENCH_MEASURE_PERFORMANCE=1');
      expect(after).toContain('BENCH_DSH_MODEL=old-model');
      expect(after).toContain('CUSTOM_UNKNOWN_KEY=kept-as-is');
      expect(after).toContain('# 保留注释：这一行必须原样存在');
      expect(after.startsWith(before.toString('utf8'))).toBe(true);
    } finally { await app.close(); }
  });

  it('不在可配置清单内的键被拒绝并给出原因', async () => {
    const root = projectRoot(baseEnvFile);
    const path = join(root, '.env');
    const before = readFileSync(path);
    const app = buildApp(':memory:', { configRoot: root, configEnv: {} });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/config', headers: { 'x-bench-token': runToken }, payload: { patch: { SOME_OTHER_TOOL_SETTING: 'x' }, confirm: true } });
      expect(response.statusCode).toBe(400);
      expect(response.json().errors[0].field).toBe('SOME_OTHER_TOOL_SETTING');
      expect(readFileSync(path)).toEqual(before);
    } finally { await app.close(); }
  });

  it('并发冲突映射为 409，不重试也不覆盖外部改动', async () => {
    const root = projectRoot(baseEnvFile);
    const path = join(root, '.env');
    const app = buildApp(':memory:', { configRoot: root, configEnv: {} });
    try {
      // 模拟：进程启动后 .env 被其它工具改动过。
      const external = readFileSync(path, 'utf8') + 'EXTERNAL_CHANGE=1\n';
      writeFileSync(path, external);
      const response = await app.inject({ method: 'POST', url: '/api/config', headers: { 'x-bench-token': runToken }, payload: { patch: { BENCH_DSH_MODEL: 'stale-write' }, confirm: true } });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toContain('重新读取');
      expect(readFileSync(path, 'utf8')).toBe(external);
    } finally { await app.close(); }
  });
});

describe('保存后即时生效', () => {
  it('无需重启：提交入口、令牌与运行档案立即按新值工作，runRoot 不受影响', async () => {
    const root = scratchRoot();
    writeFileSync(join(root, '.env'), ['# 起始配置', `BENCH_RUN_TOKEN=${runToken}`, '', ''].join('\n'));
    const submissions = join(root, 'submissions');
    const candidate = join(submissions, 'cache-02-defect');
    const runRoot = join(root, 'runs-fixed');
    const app = buildApp(join(root, 'reports.sqlite'), { configRoot: root, configEnv: {}, runRoot });
    try {
      // 起始状态：没有提交根目录，入口未启用。
      expect((await app.inject('/api/health')).json()).toMatchObject({ runEntry: false, runProfile: 'local' });

      // 写入提交根目录：同一个进程内立即生效。
      const saved = await app.inject({ method: 'POST', url: '/api/config', headers: { 'x-bench-token': runToken }, payload: { patch: { BENCH_SUBMISSIONS_DIR: submissions }, confirm: true } });
      expect(saved.statusCode).toBe(200);
      expect((await app.inject('/api/health')).json()).toMatchObject({ runEntry: true });

      // 运行入口真的按新值工作：不再是 503，能走完冻结与验证。
      exportWorkspace('CACHE-02', candidate);
      const submitted = await app.inject({
        method: 'POST', url: '/api/runs', headers: { 'x-bench-token': runToken },
        payload: { taskId: 'CACHE-02', candidateDirectory: 'cache-02-defect', idempotencyKey: 'config-live-1', submittedBy: 'config-test', reason: 'operator-submit' },
      });
      expect(submitted.statusCode).toBe(201);

      // runRoot 固定不变：配置里出现 BENCH_RUN_DIR 也不影响既有记录位置。
      const runDirWrite = await app.inject({ method: 'POST', url: '/api/config', headers: { 'x-bench-token': runToken }, payload: { patch: { BENCH_RUN_DIR: join(root, 'elsewhere') }, confirm: true } });
      expect(runDirWrite.statusCode).toBe(400);
      expect(runDirWrite.json().errors[0].field).toBe('BENCH_RUN_DIR');
      expect((await app.inject('/api/runs')).json()).toHaveLength(1);
    } finally { await app.close(); }
  }, 180_000);

  it('令牌轮换后旧令牌立即失效、新令牌立即可用（证明按操作取值）', async () => {
    const root = projectRoot(baseEnvFile);
    const app = buildApp(':memory:', { configRoot: root, configEnv: {} });
    try {
      const rotate = await app.inject({ method: 'POST', url: '/api/config', headers: { 'x-bench-token': runToken }, payload: { patch: { BENCH_RUN_TOKEN: 'second-run-token-4d5f' }, confirm: true } });
      expect(rotate.statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: '/api/config', headers: { 'x-bench-token': runToken }, payload: { patch: { BENCH_DSH_MODEL: 'x' }, confirm: true } })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/api/config', headers: { 'x-bench-token': 'second-run-token-4d5f' }, payload: { patch: { BENCH_DSH_MODEL: 'x' }, confirm: true } })).statusCode).toBe(200);
    } finally { await app.close(); }
  });
});
