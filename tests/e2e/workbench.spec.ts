import { expect, test } from '@playwright/test';

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
  await expect(page.locator('.evidence')).toHaveCount(4);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('report-mobile.png'), fullPage: true });
});
