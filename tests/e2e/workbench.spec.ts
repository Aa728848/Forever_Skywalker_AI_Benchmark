import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { exportWorkspace, applyReferencePatch, readManifest } from '../../packages/tasks/src/index.ts';

// 直接读文件而不是 import：Node ESM 导入 JSON 需要 import attribute，写法更脆。
const sample = JSON.parse(readFileSync(new URL('../../examples/assessment.json', import.meta.url), 'utf8')) as {
  evidence: unknown[];
};

test('筛选题目、保存示例预览并在刷新后显示证据', async ({ page }, testInfo) => {
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
  await page.getByRole('button', { name: '生成示例评分' }).click();
  await expect(page.getByRole('heading', { name: 'CACHE-01 · 评分预览' })).toBeVisible();
  await expect(page.locator('.score-hero strong')).toHaveText(/85\s*\/\s*100/);
  await expect(page.getByText('非正式成绩', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /评分预览/ }).click();
  await expect(page.locator('.score-hero strong')).toHaveText(/85\s*\/\s*100/);
  // 性能维度移除后，示例夹具的证据只剩 test/static/review 三类（原第四类 benchmark 随之删除）。
  // 这里断言随夹具走，避免把「示例里正好几类证据」写成与实际数据脱钩的魔法数字。
  await expect(page.locator('.evidence')).toHaveCount(sample.evidence.length);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('report-mobile.png'), fullPage: true });
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
  await page.getByRole('button', { name: /运行记录/ }).click();
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
