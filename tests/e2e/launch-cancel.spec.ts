import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processStartTime, terminateTree } from '../../scripts/experiment-supervisor.ts';

/**
 * 「取消这次测评」的端到端链路：页面点按钮 -> POST /api/experiments/:launchId/cancel ->
 * API 写取消标记 -> 真实 supervisor 代理终止子进程 -> 页面显示「已取消」。
 *
 * 这个按钮曾经点了没反应：请求带着 content-type: application/json 却没有请求体，
 * Fastify 以 400 FST_ERR_CTP_EMPTY_JSON_BODY 在业务逻辑之前拒绝。因此本用例同时钉住两件事：
 * 1. 客户端发出的取消请求不再带 JSON content-type（旧代码在这里就会失败）；
 * 2. 点下去真的取消得掉：启动记录落定为已取消，页面不出现错误提示。
 *
 * 启动记录由本用例直接写进 playwright.config.ts 注入的临时启动记录根
 * （BENCH_E2E_LAUNCHES_ROOT，仓库根的 data/launches 全程不受影响），supervisor 是真实的
 * scripts/experiment-supervisor.ts，被它监督的子进程是一个长睡不醒的假脚本——全程不调用
 * 模型、不启动容器、不碰真实实验目录。
 */

/** 仓库根：本文件位于 tests/e2e/，上溯两层。 */
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const launchesRoot = join(process.env.BENCH_E2E_ROOT!, 'launches');
const token = process.env.BENCH_E2E_TOKEN!;
const launchId = 'exp-e2e-cancel-0001';
const recordPath = join(launchesRoot, launchId + '.json');
const exitPath = join(launchesRoot, launchId + '.exit.json');
const cancelPath = join(launchesRoot, launchId + '.cancel-requested');
const childLog = join(process.env.BENCH_E2E_ROOT!, 'e2e-cancel-child.json');
const fakeChildPath = join(process.env.BENCH_E2E_ROOT!, 'e2e-cancel-fake-child.mjs');

/** 假作答子进程：落下身份回执后长时间存活，让启动记录如实停在「进行中」。 */
const fakeChild = [
  "import { writeFileSync } from 'node:fs';",
  'writeFileSync(process.env.E2E_CHILD_LOG, JSON.stringify({',
  '  pid: process.pid, record: process.env.BENCH_LAUNCH_RECORD ?? null, token: process.env.BENCH_SUPERVISOR_TOKEN ?? null,',
  "}, null, 2) + '\\n');",
  'await new Promise(resolve => setTimeout(resolve, 120_000));',
  '',
].join('\n');

const wait = (ms: number): Promise<void> => new Promise(resolvePromise => setTimeout(resolvePromise, ms));

/** 轮询直到条件成立；超时即失败并附带最后一次观察到的值。 */
async function until<T>(probe: () => T | null | undefined | false, timeoutMs = 20_000, label = '条件'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== null && value !== undefined && value !== false) return value as T;
    last = value;
    await wait(100);
  }
  throw new Error(label + ' 未在 ' + timeoutMs + 'ms 内成立；最后一次观察：' + JSON.stringify(last));
}

function isAlive(pid: number | null): boolean {
  if (pid === null) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const readJson = (path: string): Record<string, unknown> | null => {
  try { return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>; } catch { return null; }
};

/** 手工写一条「进行中」的启动记录；形状取自 launches.launch() 落盘的账本。 */
function writeLaunchRecord(childScript: string): void {
  mkdirSync(launchesRoot, { recursive: true });
  writeFileSync(recordPath, JSON.stringify({
    launchId, supervisorToken: 'e2e-cancel-supervisor-token', kind: 'comparison', experimentId: launchId,
    outputRoot: join(process.env.BENCH_E2E_ROOT!, 'experiments'),
    startedAt: new Date().toISOString(), state: 'starting', exitCode: null, logPath: join(launchesRoot, launchId + '.log'),
    plan: { taskIds: ['CACHE-02'], presets: ['standard'], modes: ['off'], repeats: 1, timeoutMinutes: 20, maxTokens: 16384,
      measurePerformance: false, provider: 'e2e-provider', model: 'e2e-model', answers: 1, concurrency: 1 },
    args: [], childScript, childArgs: [], exitPath, cancelPath,
    pid: null, pidStartedAt: null, childPid: null, childStartedAt: null, heartbeatAt: null,
    leaseTtlMs: 30_000, heartbeatMs: 5_000, descendants: [], cancelRequestedAt: null, settledAt: null, note: null,
  }, null, 2) + '\n');
}

let supervisorPid: number | null = null;
/** 子进程启动时间：取不到时「归属可证」这个前提不成立，用例如实跳过而不是伪造前提。 */
let childStartedAt: string | null = null;

test.beforeAll(async () => {
  writeFileSync(fakeChildPath, fakeChild);
  writeLaunchRecord(fakeChildPath);
  const child = spawn(process.execPath, ['--import', 'tsx', join(repositoryRoot, 'scripts', 'experiment-supervisor.ts'), '--launch-record', recordPath], {
    cwd: repositoryRoot,
    env: { ...process.env, E2E_CHILD_LOG: childLog },
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  supervisorPid = child.pid ?? null;
  // 等 supervisor 完成自登记握手并拉起子进程：这才让页面看到「进行中」。
  await until(() => {
    const record = readJson(recordPath);
    return record !== null && record.state === 'running' && record.childPid !== null ? record : null;
  }, 30_000, 'supervisor 自登记与子进程启动');
  const record = readJson(recordPath)!;
  childStartedAt = processStartTime(record.childPid as number, { cache: false });
  // 子进程确实跑起来了：告密文件由假子进程自己写下（写完才进入长睡）。
  expect(existsSync(childLog)).toBe(true);
});

test.afterAll(async () => {
  // 无论用例成败都要回收：先按记录里的子进程回收，再回收 supervisor 整棵树。
  const record = readJson(recordPath);
  const childPid = typeof record?.childPid === 'number' ? record.childPid : null;
  if (childPid !== null && isAlive(childPid)) terminateTree(childPid, { force: true });
  if (supervisorPid !== null && isAlive(supervisorPid)) terminateTree(supervisorPid, { force: true });
  await wait(500);
});

test('点「取消这次测评」真的取消：请求不带 JSON 头，启动记录落定为已取消', async ({ page, request }) => {
  // 「归属可证」是取消路由能真的终止进程的前提；本平台取不到进程启动时间时如实跳过，不伪造前提。
  test.skip(childStartedAt === null, '本平台取不到进程启动时间，无法证明子进程归属，跳过取消链路用例。');
  // 回归形状的客户端证据：取消请求必须没有 content-type（旧代码发的是 application/json 且无请求体）。
  const cancelRequest = page.waitForRequest(candidate => candidate.method() === 'POST' && candidate.url().includes('/cancel'));
  await page.goto('/');
  await page.getByRole('button', { name: /发起测评/ }).click();
  await expect(page.getByRole('heading', { name: /发起测评/ })).toBeVisible();
  // 页面用 localStorage 里的 x-bench-token 发取消请求（与配置页签共用一个键）。
  await page.locator('#launch-token').fill(token);
  await expect(page.locator('.report-item').first()).toContainText('进行中');

  await page.getByRole('button', { name: '取消这次测评' }).click();
  const sent = await cancelRequest;
  expect(sent.headers()['content-type']).toBeUndefined();

  // 服务端结论必须显示出来：这是「点了有反应」的直接证据。
  // 取消是异步的：API 写标记后由 supervisor 终止进程并在退出事实落盘后才返回（默认等待上限 10 秒），
  // 因此这里给足等待，不用「稍微等一会」把慢当成失败。
  await expect(page.locator('[role="status"]').filter({ hasText: '取消结论' })).toContainText('delegated', { timeout: 30_000 });
  await expect(page.locator('.meta-grid')).toContainText('cancelled', { timeout: 30_000 });
  // 页面不再报错，徽标变成「已取消」，按钮因进程已结束而关闭。
  await expect(page.locator('.error[role="alert"]')).toHaveCount(0);
  await expect(page.locator('.detail-top .state-tag')).toHaveText('已取消', { timeout: 30_000 });
  await expect(page.getByRole('button', { name: '取消这次测评' })).toBeDisabled();

  // API 侧同一份事实：启动记录落定为 cancelled，取消标记与退出事实都已落盘。
  const views = (await (await request.get('http://127.0.0.1:4318/api/experiments')).json()).launches as Array<{ launchId: string; state: string; cancelRequested: boolean; merged: { verdict: string; process: string } }>;
  const view = views.find(item => item.launchId === launchId);
  expect(view?.state).toBe('cancelled');
  expect(view?.cancelRequested).toBe(true);
  expect(view?.merged.verdict).toBe('cancelled');
  expect(existsSync(cancelPath)).toBe(true);
  expect(existsSync(exitPath)).toBe(true);
  const exit = readJson(exitPath) as { cancelled: boolean } | null;
  expect(exit?.cancelled).toBe(true);
});
