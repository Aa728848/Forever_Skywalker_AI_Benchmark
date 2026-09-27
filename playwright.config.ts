import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.PLAYWRIGHT_BROWSERS_PATH ??= fileURLToPath(new URL('./.cache/playwright', import.meta.url));
process.env.BENCH_E2E_ROOT ??= mkdtempSync(join(tmpdir(), 'fsa-e2e-'));
process.env.BENCH_E2E_TOKEN ??= randomUUID();
// 配置根必须先存在：@fsa/config 的 readProjectEnvironment 会对根做 realpathSync，
// 目录不存在会直接启动失败（它自己不会创建目录）。
const configRoot = join(process.env.BENCH_E2E_ROOT, 'config');
mkdirSync(configRoot, { recursive: true });
// 临时配置根的起始夹具。裁判链路必须先在文件里成型，「裁判令牌」这个密钥字段才走得通：
// apps/api/src/config.ts 在校验任何 BENCH_JUDGE_* 补丁时会先做本地裁判配置检查，没有链路时
// 一律按既有行为拒绝（见 apps/api/src/config.test.ts 的已知约束用例）。这里只写本地字段，
// 端点指向不会解析的域名，测试全程不发起任何请求。
// 不写 BENCH_JUDGE_TOKEN：密钥字段要能从「未填写」走到「已填写」。
// 只在缺失时创建：Playwright 会在主进程与 worker 进程各加载一次本文件，重复写入会让
// API 已缓存的 .env 修订号失效，下一次保存被判成并发冲突（409）而失败。
const configEnvFixture = join(configRoot, '.env');
if (!existsSync(configEnvFixture)) writeFileSync(configEnvFixture, [
  '# e2e 临时配置根夹具，不是仓库配置。',
  'BENCH_JUDGE_ENDPOINT=https://judge.invalid/v1',
  'BENCH_JUDGE_MODEL=e2e-judge-model',
  '',
].join('\n'));

/**
 * API webServer 的内联入口。apps/api/src/server.ts 既不接受配置根参数，也不在本阶段的
 * 允许改动清单内，因此这里直接组合既有导出：buildApp(databasePath, AppOptions)。
 * 只替换 server.ts 的进程入口，行为与其一致（同样的 BENCH_DB 缺省、host、port 与关闭钩子）；
 * 唯一的增加项是把 configRoot 指向临时目录，保证 e2e 永不读写仓库根的 .env。
 */
// launchesRoot 指向本次运行的临时根：否则「发起测评」页签会读写仓库根的 data/launches，
// e2e 既不该看见真实启动记录，也不该往里写。测试自己往该目录写启动记录、并与真实 supervisor 交互。
const apiEntry = "const m=await import('./apps/api/src/app.ts');"
  + "const app=m.buildApp(process.env.BENCH_DB??':memory:',{configRoot:process.env.BENCH_CONFIG_ROOT,launchesRoot:process.env.BENCH_E2E_LAUNCHES_ROOT});"
  + "await app.listen({host:'127.0.0.1',port:Number(process.env.BENCH_API_PORT??4318)});"
  + "process.once('SIGINT',()=>{void app.close();});process.once('SIGTERM',()=>{void app.close();});";

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  globalTeardown: './tests/e2e/teardown.ts',
  use: { baseURL: 'http://127.0.0.1:4317', viewport: { width: 1440, height: 1080 }, trace: 'retain-on-failure' },
  webServer: [
    // apps/api/src/server.ts 不接受配置根参数，也不得改动 apps/**；这里用内联入口把 AppOptions.configRoot
    // 指向本次运行的临时配置根，理由与边界见 tests/e2e/config-panel.spec.ts 的注释。
    { command: `node --import tsx --input-type=module --eval "${apiEntry}"`, url: 'http://127.0.0.1:4318/api/health', env: { BENCH_CONFIG_ROOT: configRoot, BENCH_E2E_LAUNCHES_ROOT: join(process.env.BENCH_E2E_ROOT, 'launches'), BENCH_API_PORT: '4318', BENCH_DB: ':memory:', BENCH_RUN_DIR: join(process.env.BENCH_E2E_ROOT, 'runs'), BENCH_SUBMISSIONS_DIR: process.env.BENCH_E2E_ROOT, BENCH_DSH_REPORT_DIR: join(process.env.BENCH_E2E_ROOT, 'experiments'), BENCH_RUN_TOKEN: process.env.BENCH_E2E_TOKEN, BENCH_PROFILE: 'local', BENCH_JUDGE_ENDPOINT: '', BENCH_JUDGE_TOKEN: '', BENCH_MEASURE_PERFORMANCE: '0' }, reuseExistingServer: false },
    { command: 'node apps/web/node_modules/vite/bin/vite.js apps/web --host 127.0.0.1 --port 4317 --strictPort', url: 'http://127.0.0.1:4317', reuseExistingServer: false },
  ],
});
