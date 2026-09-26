import { expect, test, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 「配置」页签的端到端验收：在真实浏览器里点击该页签，验证令牌拒绝、写入 .env 后刷新仍生效、
 * 密钥只显示是否已填写、只读项被标注为不可改。
 *
 * 隔离机制：playwright.config.ts 把 BENCH_CONFIG_ROOT 指向 <BENCH_E2E_ROOT>/config，
 * API 的 webServer 用内联入口把它交给 buildApp 的 configRoot，因此本文件里所有写入
 * 都落在本次运行的临时目录；仓库根的 .env 不存在，而且每个用例都会核实它没有被创建。
 * 全程不调用模型或裁判：只有本地 .env 读写与本地配置校验。
 */

/** 仓库根：本文件位于 tests/e2e/，上溯两层。 */
const repositoryEnvFile = join(fileURLToPath(new URL('../../', import.meta.url)), '.env');
/** 运行开始前的仓库根 .env 快照；用例结束时必须仍然相同（当前为 null，即从未被创建）。 */
const repositoryEnvSnapshot = existsSync(repositoryEnvFile) ? readFileSync(repositoryEnvFile, 'utf8') : null;

const e2eRoot = process.env.BENCH_E2E_ROOT!;
/** 与 playwright.config.ts 的 BENCH_CONFIG_ROOT 保持一致。 */
const configRoot = join(e2eRoot, 'config');
const configEnvFile = join(configRoot, '.env');
const apiBase = 'http://127.0.0.1:4318';
const token = process.env.BENCH_E2E_TOKEN!;
const configPost = (page: Page) => page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/config'));

/** 临时配置根里的 .env 内容；不存在时为 null。 */
const configEnvNow = (): string | null => existsSync(configEnvFile) ? readFileSync(configEnvFile, 'utf8') : null;
/** 仓库根 .env 内容；不存在时为 null。 */
const repositoryEnvNow = (): string | null => existsSync(repositoryEnvFile) ? readFileSync(repositoryEnvFile, 'utf8') : null;

/** ConfigPanel 根 section：断言限定在该页签内，避免与其它页签的同名元素混淆。 */
const configPanel = (page: Page) => page.locator('section').filter({ has: page.locator('#config-token') });

async function openConfigTab(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: /配置/ }).click();
  await expect(configPanel(page).locator('.config-grid')).toBeVisible();
}

/** 只读键与它们各自的不可改原因（apps/api/src/config.ts 的 readOnlyKeyReasons）。 */
const readOnlyKeys: ReadonlyArray<readonly [string, string]> = [
  ['BENCH_RUN_DIR', '既有运行记录的物理位置'],
  ['BENCH_DSH_ROOT', 'DSH 安装目录'],
  ['BENCH_DSH_HOME', 'DSH 配置目录'],
  ['BENCH_DSH_PROFILE', 'profile 名称'],
  ['BENCH_IMAGE', '固定 Linux 镜像引用'],
  ['BENCH_IMAGE_DIGEST', '固定镜像摘要'],
  ['BENCH_PROFILE', '平台执行档案'],
];

test('未输入令牌时写操作被拒绝并提示；输入令牌后写入 .env 且刷新后仍生效', async ({ page }, testInfo) => {
  const before = configEnvNow();
  await openConfigTab(page);

  // 配置根就是本次运行的临时目录：证明没有任何写入会落到仓库根 .env。
  const shownPath = (await configPanel(page).locator('.experiment-path').innerText()).toLowerCase();
  expect(shownPath).toContain(join(configRoot, '.env').toLowerCase());
  expect(shownPath).not.toContain(join(fileURLToPath(new URL('../../', import.meta.url))).toLowerCase());

  // 未填写令牌：页签自己说明写操作会被拒绝。
  await expect(configPanel(page).locator('.token-bar span')).toHaveText('未填写：写操作会被拒绝（401）');
  await page.locator('#config-BENCH_DSH_PRESETS').selectOption('ptc');
  // 浏览器里点「保存」触发的是真实写请求：必须真的收到 401，而不只是看着像被拒绝。
  const [rejected] = await Promise.all([configPost(page), page.getByRole('button', { name: '保存 1 项改动' }).click()]);
  expect(rejected.status()).toBe(401);
  expect(await rejected.text()).toContain('x-bench-token');
  await expect(configPanel(page).getByRole('alert')).toContainText('令牌无效或已失效，请重新输入 x-bench-token。');
  // 401 之后磁盘状态不变：临时 .env 与仓库根 .env 都没有被动过。
  expect(configEnvNow()).toBe(before);
  expect(repositoryEnvNow()).toBe(repositoryEnvSnapshot);

  // 输入令牌后可用：先看到待写清单，确认后才写入。
  await page.getByLabel('访问令牌 x-bench-token').fill(token);
  await expect(configPanel(page).locator('.token-bar span')).toHaveText('已保存在此浏览器本地');
  await page.getByRole('button', { name: '保存 1 项改动' }).click();
  const dialog = page.getByRole('dialog', { name: '确认写入配置' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('tbody tr')).toHaveCount(1);
  await expect(dialog.locator('tbody tr')).toContainText('BENCH_DSH_PRESETS');
  await expect(dialog.locator('tbody tr')).toContainText('ptc');

  const [saved] = await Promise.all([configPost(page), dialog.getByRole('button', { name: '确认写入' }).click()]);
  expect(saved.status()).toBe(200);
  await expect(configPanel(page).locator('.notice[role="status"]')).toContainText('已写入 BENCH_DSH_PRESETS');

  // 真的写进了 .env：直接读磁盘上的临时配置文件，而不是只看界面。
  expect(configEnvNow()).toContain('BENCH_DSH_PRESETS=ptc');
  expect(repositoryEnvNow()).toBe(repositoryEnvSnapshot);

  // 刷新页面后新值仍在（API 按保存后的快照重算视图）。
  await page.reload();
  await page.getByRole('button', { name: /配置/ }).click();
  await expect(page.locator('#config-BENCH_DSH_PRESETS')).toHaveValue('ptc');
  await expect(page.locator('#config-token')).toHaveValue(token);
  await page.screenshot({ path: testInfo.outputPath('config-panel.png'), fullPage: true });
});

test('密钥字段只显示已填写/未填写，页面上与响应里都不出现密钥值', async ({ page }, testInfo) => {
  // 只用于本用例的轮换值：出现在页面上即为泄漏。
  const rotated = 'e2e-rotated-judge-token-8c41';
  await openConfigTab(page);
  await page.getByLabel('访问令牌 x-bench-token').fill(token);

  const secret = page.locator('#config-BENCH_JUDGE_TOKEN');
  // 未配置：只说明「未填写」，输入框为空。
  await expect(secret).toHaveAttribute('type', 'password');
  await expect(secret).toHaveAttribute('placeholder', '未填写');
  await expect(secret).toHaveValue('');

  // 输入新密钥并请求待写清单：响应正文与弹窗都只说「已填写」。
  await secret.fill(rotated);
  const [planned] = await Promise.all([configPost(page), page.getByRole('button', { name: '保存 1 项改动' }).click()]);
  expect(planned.status()).toBe(200);
  expect(await planned.text()).not.toContain(rotated);
  const dialog = page.getByRole('dialog', { name: '确认写入配置' });
  await expect(dialog).toContainText('BENCH_JUDGE_TOKEN');
  await expect(dialog).toContainText('已填写（新值不会回显）');
  await expect(dialog).not.toContainText(rotated);

  const [saved] = await Promise.all([configPost(page), dialog.getByRole('button', { name: '确认写入' }).click()]);
  expect(saved.status()).toBe(200);
  expect(await saved.text()).not.toContain(rotated);
  // 值确实写进了临时 .env（磁盘上有，页面上没有）。
  expect(configEnvNow()).toContain('BENCH_JUDGE_TOKEN=' + rotated);
  expect(repositoryEnvNow()).toBe(repositoryEnvSnapshot);
  await expect(secret).toHaveValue('');

  // 刷新后按「已填写」呈现，且不回显值。
  await page.reload();
  await page.getByRole('button', { name: /配置/ }).click();
  await expect(page.locator('#config-BENCH_JUDGE_TOKEN')).toHaveAttribute('placeholder', '已填写（留空表示不修改）');
  await expect(page.locator('#config-BENCH_JUDGE_TOKEN')).toHaveValue('');
  expect(await page.evaluate(() => document.body.innerText)).not.toContain(rotated);
  expect(await page.content()).not.toContain(rotated);
  await page.getByRole('button', { name: /报告中心/ }).click();
  await page.getByRole('button', { name: /配置/ }).click();
  await expect(page.locator('#config-BENCH_JUDGE_TOKEN')).toHaveValue('');
  await page.screenshot({ path: testInfo.outputPath('config-panel-secret.png'), fullPage: true });
});

test('只读字段被显著标注为不可改，且服务端真的拒绝写入', async ({ page, request }, testInfo) => {
  const before = configEnvNow();
  await openConfigTab(page);

  const readOnly = configPanel(page).locator('article.config-group').filter({ hasText: '只读项' });
  await expect(readOnly.getByRole('heading', { name: /只读项/ })).toBeVisible();
  await expect(readOnly).toContainText('网页不可编排；请用 CLI 或环境变量修改后重启服务');

  // 每个只读键一格：键名（span）、当前值（b）、以及「请用 CLI 或环境变量修改」的原因。
  // 用键名那一行的精确匹配定位，保证 BENCH_IMAGE 不会命中 BENCH_IMAGE_DIGEST 那一格。
  const rowOf = (key: string) => readOnly.locator(`.meta-grid > div:has(span:text-is("${key}"))`);
  for (const [key, reason] of readOnlyKeys) {
    await expect(rowOf(key), key).toHaveCount(1);
    await expect(rowOf(key), key).toContainText(reason);
    await expect(rowOf(key), key).toContainText('CLI');
    // 页签里没有这些键的编辑控件：不可改不是靠提示，而是没有入口。
    await expect(page.locator('#config-' + key), key).toHaveCount(0);
  }
  // 有值的只读项显示真实值（运行目录与档案来自 webServer 环境），未设置的显示（未设置）而不是空白。
  await expect(rowOf('BENCH_RUN_DIR')).toContainText('runs');
  await expect(rowOf('BENCH_PROFILE')).toContainText('local');
  await expect(rowOf('BENCH_IMAGE')).toContainText('（未设置）');

  // 服务端同样拒绝：标注与约束一致，而不是只有提示。
  for (const [key] of readOnlyKeys) {
    const response = await request.post(apiBase + '/api/config', { headers: { 'x-bench-token': token }, data: { patch: { [key]: 'e2e-attempt' }, confirm: true } });
    expect(response.status(), key).toBe(400);
    expect((await response.json()).errors[0].message, key).toContain('该配置不能通过网页修改');
  }
  expect(configEnvNow()).toBe(before);
  expect(repositoryEnvNow()).toBe(repositoryEnvSnapshot);
  await page.screenshot({ path: testInfo.outputPath('config-panel-readonly.png'), fullPage: true });
});
