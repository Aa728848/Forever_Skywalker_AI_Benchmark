import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// 报告根由 playwright.config.ts 注入（BENCH_DSH_REPORT_DIR 指向 <BENCH_E2E_ROOT>/experiments）。
const reportRoot = join(process.env.BENCH_E2E_ROOT!, 'experiments');
// 目录名以时间戳开头，列表按目录名倒序，因此这个名字会排在其它夹具之前。
const target = '2026-09-15T00-00-00-000Z-e2eclean1';
// API 的 webServer 用 BENCH_RUN_TOKEN 注入随机令牌（playwright.config.ts），
// 这里必须用同一个值，否则「缺令牌被拒」那条会与「有令牌成功」混为一谈。
const token = process.env.BENCH_E2E_TOKEN!;

const document = {
  schemaVersion: '0.3.0',
  id: 'e2e-cleanup-experiment',
  startedAt: '2026-09-15T00:00:00.000Z',
  finishedAt: '2026-09-15T00:05:00.000Z',
  state: 'completed',
  settings: { provider: 'e2e-provider', model: 'e2e-model', presets: ['standard'], modes: ['high'], repeats: 1, taskIds: ['CACHE-02'] },
  rows: [],
  issues: [],
  progress: [],
  evidence: null,
  cleanup: { state: 'complete', directory: null, reason: null },
};

test.beforeAll(() => {
  mkdirSync(join(reportRoot, target), { recursive: true });
  writeFileSync(join(reportRoot, target, 'experiment.json'), JSON.stringify(document));
  writeFileSync(join(reportRoot, target, 'report.md'), '# 待清理的实验\n');
});

test('报告中心能清理一份报告：移入回收目录、列表不再显示、文件未删除', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /报告中心/ }).click();

  // 选中刚写入的那份报告。
  await page.getByRole('button', { name: /e2e-cleanup-experiment/ }).first().click();
  await expect(page.getByText('报告目录 ' + target)).toBeVisible();

  // 清理是两步：先点开会看到确认块，但此刻还没有发出任何删除请求。
  await page.getByRole('button', { name: '清理这份报告…' }).click();
  await expect(page.getByText('确认清理「e2e-cleanup-experiment」？')).toBeVisible();
  expect(existsSync(join(reportRoot, target))).toBe(true);

  // 填令牌后确认清理。
  await page.getByLabel('运行令牌').fill(token);
  await page.getByRole('button', { name: '确认清理' }).click();

  // 必须给出可见结论，并且说明是移入回收目录而非删除。
  await expect(page.getByText(/已移入回收目录/)).toBeVisible();
  // 原目录必须已被移走，但内容必须仍在回收目录里。
  await expect.poll(() => existsSync(join(reportRoot, target))).toBe(false);
  const trash = join(reportRoot, '.trash');
  expect(existsSync(trash)).toBe(true);
  const containers = readdirSync(trash);
  expect(containers.length).toBeGreaterThan(0);
  const restored = containers.some(name => existsSync(join(trash, name, target, 'experiment.json')));
  expect(restored).toBe(true);

  // 清理成功后页面自行刷新（setRevision），已清理的报告不应再出现在列表里。
  // 这里不再点「刷新报告」：空列表状态会额外渲染一个同名按钮，严格模式会因歧义失败。
  await expect(page.getByText('e2e-cleanup-experiment')).toHaveCount(0);
});

test('缺少令牌时清理被拒绝，报告留在原处', async ({ page }) => {
  const guarded = '2026-09-15T00-01-00-000Z-e2eclean2';
  mkdirSync(join(reportRoot, guarded), { recursive: true });
  writeFileSync(join(reportRoot, guarded, 'experiment.json'), JSON.stringify({ ...document, id: 'e2e-cleanup-guarded' }));
  await page.goto('/');
  await page.getByRole('button', { name: /报告中心/ }).click();
  await page.getByRole('button', { name: /e2e-cleanup-guarded/ }).first().click();
  await page.getByRole('button', { name: '清理这份报告…' }).click();
  // 故意留空令牌。
  await page.getByLabel('运行令牌').fill('');
  await page.getByRole('button', { name: '确认清理' }).click();
  await expect(page.getByText(/令牌无效或已失效/)).toBeVisible();
  expect(existsSync(join(reportRoot, guarded))).toBe(true);
});