import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { exportWorkspace, applyReferencePatch, readManifest } from '../../packages/tasks/src/index.ts';

test('筛选题目；提交与记录页签同页提供提交入口，评分预览页签已不存在', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'TTL 与有界淘汰', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '搜索题目' }).fill('CACHE-');
  await expect(page.locator('.task-row')).toHaveCount(4);
  await page.getByLabel('难度', { exact: true }).selectOption('hard');
  await expect(page.locator('.task-row')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: '失效期间的在途旧结果', exact: true })).toBeVisible();
  await page.getByLabel('难度', { exact: true }).selectOption('all');
  await page.getByRole('textbox', { name: '搜索题目' }).fill('');
  await page.screenshot({ path: testInfo.outputPath('catalog-desktop.png'), fullPage: true });

  // 评分预览展示的是 examples/assessment.json 的固定样例分，不是任何真实作答的结论，已删除。
  await expect(page.getByRole('button', { name: /评分预览/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '生成示例评分' })).toHaveCount(0);

  // 外部作答提交与运行记录同页：提交后要看的正是它的执行明细。
  await page.getByRole('button', { name: /提交与记录/ }).click();
  await expect(page.getByRole('heading', { name: '提交与记录' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '提交外部作答' })).toBeVisible();
  await expect(page.getByLabel('候选目录')).toBeVisible();
  await expect(page.getByLabel('题目')).toBeVisible();
  // 没有令牌时提交按钮仍可点，但服务端会拒绝——断言的是入口确实可用而不是被藏起来。
  await expect(page.getByRole('button', { name: '提交外部作答' })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('submit-mobile.png'), fullPage: true });
});

test('真实提交后显示待定质量、执行证据和不补齐缺测的四级汇总', async ({ page, request }, testInfo) => {
  const root = process.env.BENCH_E2E_ROOT!;
  const candidate = join(root, 'candidate');
  exportWorkspace('CACHE-02', candidate);
  expect(applyReferencePatch(readManifest('CACHE-02'), candidate, join(root, 'patch')).exitCode).toBe(0);
  const response = await request.post('http://127.0.0.1:4318/api/runs', { headers: { 'x-bench-token': process.env.BENCH_E2E_TOKEN! }, data: { taskId: 'CACHE-02', candidateDirectory: candidate, idempotencyKey: 'browser-flow', submittedBy: 'e2e', reason: 'agent-completed' } });
  expect(response.status()).toBe(201);
  const status = await response.json();
  expect(status.classification).toBe('passed');
  expect(status.scoring).toMatchObject({ functional: 50, quality: null, total: null, mode: 'local' });
  const selected = { runId: status.runId, attemptId: status.attemptId };
  const duplicate = await request.post('http://127.0.0.1:4318/api/summaries', { data: [selected, selected] });
  expect(duplicate.status()).toBe(400);
  await page.goto('/');
  await page.getByRole('button', { name: /提交与记录/ }).click();
  await expect(page.getByRole('heading', { name: 'CACHE-02 · 执行报告' })).toBeVisible();
  await expect(page.locator('.score-hero strong')).toContainText('待定');
  await expect(page.locator('.timeline')).toContainText('score.finalized');
  await page.getByRole('checkbox', { name: /加入汇总 CACHE-02/ }).check();
  await page.getByRole('button', { name: '汇总所选 1 次作答' }).click();
  await expect(page.getByRole('heading', { name: '四级汇总 · 本机诊断' })).toBeVisible();
  await expect(page.locator('.suite-summary')).toContainText('核心加权总分：待定');
  await expect(page.locator('.suite-summary tbody tr')).toHaveCount(4);
  const artifact = await request.get(`http://127.0.0.1:4318/api/runs/${status.runId}/${status.attemptId}/artifacts/${status.artifacts[0].id}`);
  expect(artifact.ok()).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('run-report-mobile.png'), fullPage: true });
});
