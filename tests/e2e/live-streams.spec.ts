import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 「作答中的实时输出」的多框视图。
 *
 * 钉住四件事：
 * 1. 并发的每条作答各占一框（此前所有作答挤在一个面板里）；
 * 2. 每排最多两个框，多的往下排；
 * 3. 已结束的作答收成摘要条（不占主视图的位置），点开能看完整过程；
 * 4. 框里能看到助手输出、工具调用与工具结果（此前只有工具名）。
 *
 * 启动记录与 launch.log 由本用例直接写进 playwright.config.ts 注入的临时启动记录根
 * （BENCH_E2E_LAUNCHES_ROOT，仓库根的 data/launches 全程不受影响）。不启动 supervisor、
 * 不调用模型、不碰真实实验目录。
 */

const launchesRoot = join(process.env.BENCH_E2E_ROOT!, 'launches');
const launchId = 'exp-e2e-live-0001';
const recordPath = join(launchesRoot, launchId + '.json');
const logPath = join(launchesRoot, launchId + '.log');

/** 三条作答：一条已结束、两条在跑——覆盖「按作答分框」与「结束的收成摘要条」。 */
const logText = [
  '[2026-10-19T06:11:55.991Z] supervisor 已登记 pid=1234，准备启动子进程',
  '  CACHE-04 · ptc/max · 第1次 › phase: 作答中',
  '  CACHE-04 · ptc/max · 第1次 › text: 先读缓存实现，再补并发用例。',
  '  CACHE-04 · ptc/max · 第1次 › tool: read｜file_path=src/cache.ts limit=200',
  '  CACHE-04 · ptc/max · 第1次 › result: ok｜read｜导出一个 Map 缓存',
  '  CACHE-04 · ptc/max · 第1次 › phase: 已完成',
  '  CONC-04 · ptc/max · 第1次 › phase: 作答中',
  '  CONC-04 · ptc/max · 第1次 › text: 并发下的锁竞争要先复现再修。',
  '  CONC-04 · ptc/max · 第1次 › tool: pwsh｜command=pnpm test',
  '  CONC-04 · ptc/max · 第1次 › result: err｜pwsh｜命令失败：3 个用例未通过',
  '  ARCH-04 · ptc/max · 第1次 › phase: 作答中',
  '  ARCH-04 · ptc/max · 第1次 › text: 先画出依赖边界。',
  '',
].join('\n');

test.beforeAll(() => {
  mkdirSync(launchesRoot, { recursive: true });
  writeFileSync(logPath, logText);
  // 形状取自 launches.launch() 落盘的账本：只读页面不需要 supervisor 真的在跑。
  writeFileSync(recordPath, JSON.stringify({
    launchId, supervisorToken: 'e2e-live-supervisor-token', kind: 'comparison', experimentId: launchId,
    outputRoot: join(process.env.BENCH_E2E_ROOT!, 'experiments'),
    startedAt: new Date().toISOString(), state: 'running', exitCode: null, logPath,
    plan: { taskIds: ['CACHE-04'], presets: ['ptc'], modes: ['max'], repeats: 1, timeoutMinutes: 20, maxTokens: 16384,
      measurePerformance: false, provider: 'e2e-provider', model: 'e2e-model', answers: 3, concurrency: 3 },
    args: [], childScript: join(process.env.BENCH_E2E_ROOT!, 'e2e-live-fake-child.mjs'), childArgs: [], exitPath: recordPath.replace('.json', '.exit.json'),
    cancelPath: recordPath.replace('.json', '.cancel-requested'),
    pid: null, pidStartedAt: null, childPid: null, childStartedAt: null, heartbeatAt: new Date().toISOString(),
    leaseTtlMs: 600_000, heartbeatMs: 5_000, descendants: [], cancelRequestedAt: null, settledAt: null, note: null,
  }, null, 2) + '\n');
});

test('并发作答各占一框：每排最多两个，结束的收成摘要条，全屏层能看完整过程', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: '发起测评', exact: true }).click();
  await expect(page.getByRole('heading', { name: /发起测评/ })).toBeVisible();
  await page.locator('.report-item', { hasText: launchId }).click();

  // 在跑的两条作答各占一框。
  const boxes = page.locator('.live-box');
  await expect(boxes).toHaveCount(2);
  await expect(boxes.nth(0)).toContainText('CONC-04');
  await expect(boxes.nth(1)).toContainText('ARCH-04');
  // 框里能看到工具调用与工具结果，不只是工具名。
  await expect(boxes.nth(0).locator('.live-tool')).toContainText('pwsh');
  await expect(boxes.nth(0).locator('.live-result')).toContainText('失败');
  await expect(boxes.nth(0).locator('.live-line.live-text')).toContainText('锁竞争');

  // 每排最多两个：两个框在同一行，左右并排。
  const first = await boxes.nth(0).boundingBox();
  const second = await boxes.nth(1).boundingBox();
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(Math.abs((first?.y ?? 0) - (second?.y ?? 0))).toBeLessThan(4);
  expect(second?.x ?? 0).toBeGreaterThan(first?.x ?? 0);

  // 已结束的那条收成摘要条，不占主视图的位置。
  await expect(page.locator('.live-summary')).toHaveCount(1);
  await expect(page.locator('.live-summary')).toContainText('CACHE-04');
  // 原始日志折叠保留，排查时仍能对照。
  await expect(page.locator('.live-raw summary')).toContainText('原始日志');

  // 全屏层：三条作答都在，仍然每排两个。
  await page.getByRole('button', { name: '全部输出' }).click();
  const overlayBoxes = page.locator('.live-overlay .live-box');
  await expect(overlayBoxes).toHaveCount(3);
  const top = await overlayBoxes.nth(0).boundingBox();
  const beside = await overlayBoxes.nth(1).boundingBox();
  const below = await overlayBoxes.nth(2).boundingBox();
  expect(Math.abs((top?.y ?? 0) - (beside?.y ?? 0))).toBeLessThan(4);
  expect(below?.y ?? 0).toBeGreaterThan((top?.y ?? 0) + 10);
  // Esc 关闭覆盖层。
  await page.keyboard.press('Escape');
  await expect(page.locator('.live-overlay')).toHaveCount(0);

  // 视觉证据：多框面板的整页截图（落在 test-results 下，不入库）。
  await page.screenshot({ path: testInfo.outputPath('live-streams.png'), fullPage: true });
});
