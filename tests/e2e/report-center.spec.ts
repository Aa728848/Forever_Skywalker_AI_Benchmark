import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { experimentDetailValidator, explainExperimentDetail } from '../../packages/contracts/src/index.ts';

// API 的 webServer 环境把 BENCH_DSH_REPORT_DIR 指向本目录（见 playwright.config.ts）。
const reportRoot = join(process.env.BENCH_E2E_ROOT!, 'experiments');
const goodName = '2026-09-14T00-00-00-000Z-e2e00001';
const brokenName = '2026-09-14T00-10-00-000Z-e2e00002';
// 目录名以时间戳开头，列表按目录名倒序；进行中的实验排在最后，不抢默认选中项。
const runningName = '2026-09-13T00-00-00-000Z-e2e00003';
const pollName = '2026-09-12T00-00-00-000Z-e2e00004';
const evidenceBytes = Buffer.from('{"schemaVersion":"0.1.0","files":[]}\n', 'utf8');
const evidenceSha = createHash('sha256').update(evidenceBytes).digest('hex');

/** 与 @fsa/evaluation 落盘的 experiment.json 同形；出口只读取下表所列字段。 */
function solver(finishReason: string | null, durationMs: number | null) {
  return { finishReason, durationMs, finalResponse: 'E2E 夹具作答', usage: null, dshVersion: 'e2e-fixture', cleanupScope: 'sdk-runtime' };
}

function evaluation(classification: string | null, runId: string | null, attemptId: string | null, total: number | null) {
  return { environmentKey: 'e2e-environment-key', judgeKey: null, status: { classification, runId, attemptId, evidenceRefs: [], scoring: { functional: null, quality: null, total } } };
}

const rows = [
  { taskId: 'CACHE-02', taskVersion: '0.3.0', preset: 'standard', mode: 'off', repetition: 1, sessionId: 'e2e-session-1', phase: 'done', solver: solver('completed', 12340), evaluation: evaluation('passed', 'run-e2e-1', 'attempt-e2e-1', 100), error: null },
  { taskId: 'CACHE-02', taskVersion: '0.3.0', preset: 'standard', mode: 'high', repetition: 1, sessionId: 'e2e-session-2', phase: 'done', solver: solver('completed', 22100), evaluation: evaluation(null, 'run-e2e-2', 'attempt-e2e-2', null), error: null },
  { taskId: 'CACHE-02', taskVersion: '0.3.0', preset: 'ptc', mode: 'off', repetition: 1, sessionId: 'e2e-session-3', phase: 'grading', solver: solver('completed', 5000), evaluation: null, error: null },
  { taskId: 'CACHE-02', taskVersion: '0.3.0', preset: 'ptc', mode: 'high', repetition: 1, sessionId: 'e2e-session-4', phase: 'solver-stopped', solver: solver('timeout', 900000), evaluation: null, error: null },
  { taskId: 'CACHE-02', taskVersion: '0.3.0', preset: 'minimal', mode: 'off', repetition: 1, sessionId: 'e2e-session-5', phase: 'pending', solver: null, evaluation: null, error: null },
];

const experimentDocument = {
  schemaVersion: '0.3.0',
  id: 'e2e-fixture-experiment',
  startedAt: '2026-09-14T00:00:00.000Z',
  finishedAt: '2026-09-14T00:10:00.000Z',
  state: 'completed',
  settings: { provider: 'e2e-provider', model: 'e2e-model', presets: ['standard', 'ptc', 'minimal'], modes: ['off', 'high'], repeats: 1,
    taskIds: ['CACHE-02'], profile: 'e2e-profile', workspacePermission: 'workspace-write', maxTokens: 4096, timeoutMs: 600000,
    dshRoot: '/e2e/dsh', dshHome: '/e2e/home', measurePerformance: false, outputDirectory: '/e2e/out' },
  prompt: 'E2E 夹具提示',
  rows,
  issues: ['E2E 夹具问题：仅用于验证问题区域渲染。'],
  progress: [
    { at: '2026-09-14T00:00:00.000Z', message: 'CACHE-02 · standard / off · 第 1 次：DSH 作答中' },
    { at: '2026-09-14T00:01:00.000Z', message: 'CACHE-02 · standard / off：Linux 验证与评分中' },
    { at: '2026-09-14T00:02:00.000Z', message: 'CACHE-02 · ptc / high · 第 1 次：DSH 作答中' },
  ],
  evidence: { filename: 'evidence.json.gz', sha256: evidenceSha, fileCount: 3 },
  cleanup: { state: 'complete', directory: null, reason: null },
};

const runningDocument = { ...experimentDocument, id: 'e2e-running-experiment', state: 'running', finishedAt: null,
  settings: { ...experimentDocument.settings, provider: 'e2e-running-provider', model: 'e2e-running-model' } };
const pollDocument = { ...experimentDocument, id: 'e2e-poll-experiment', state: 'running', finishedAt: null,
  settings: { ...experimentDocument.settings, provider: 'e2e-poll-provider', model: 'e2e-poll-model' } };

/** 夹具必须先通过出口协议校验，避免用一份畸形 JSON 假装成"有效报告"。 */
test('夹具 experiment.json 必须通过 ExperimentDetailSchema', () => {
  const projected = {
    reportId: 'e2e-report-id', root: reportRoot, directoryName: goodName,
    modifiedAt: '2026-09-14T00:00:00.000Z', status: 'ok', error: null,
    id: experimentDocument.id, startedAt: experimentDocument.startedAt, finishedAt: experimentDocument.finishedAt, state: experimentDocument.state,
    provider: 'e2e-provider', model: 'e2e-model',
    presets: experimentDocument.settings.presets, modes: experimentDocument.settings.modes,
    taskCount: experimentDocument.settings.taskIds.length, planned: rows.length,
    phaseCounts: { pending: 1, solving: 0, grading: 1, done: 2, solverStopped: 1, error: 0 },
    evidence: experimentDocument.evidence, cleanup: experimentDocument.cleanup,
    settings: experimentDocument.settings,
    // 出口协议的行没有 error 字段：逐字段投影，不能整体展开原始记录。
    rows: rows.map(row => ({ taskId: row.taskId, taskVersion: row.taskVersion, preset: row.preset, mode: row.mode, repetition: row.repetition,
      sessionId: row.sessionId, phase: row.phase, solver: row.solver, evaluation: row.evaluation,
      finishReason: row.solver?.finishReason ?? null, durationMs: row.solver?.durationMs ?? null,
      classification: row.evaluation?.status.classification ?? null, runId: row.evaluation?.status.runId ?? null,
      attemptId: row.evaluation?.status.attemptId ?? null, total: row.evaluation?.status.scoring.total ?? null })),
    issues: experimentDocument.issues, progress: experimentDocument.progress,
  };
  const problems = explainExperimentDetail(projected);
  expect(problems).toEqual([]);
  expect(experimentDetailValidator.Check(projected)).toBe(true);
});

test('报告中心列出实验、展开行级阶段与进度，下载四个产物；损坏报告仍可见', async ({ page, request }, testInfo) => {
  // 记录明细请求，用来验证"进行中"实验的 5 秒轮询。
  const detailRequests: string[] = [];
  page.on('request', request => { const url = request.url(); if (url.includes('/api/reports/') && !url.includes('/artifacts/')) detailRequests.push(url); });
  mkdirSync(join(reportRoot, goodName), { recursive: true });
  writeFileSync(join(reportRoot, goodName, 'experiment.json'), JSON.stringify(experimentDocument, null, 2) + '\n');
  writeFileSync(join(reportRoot, goodName, 'report.md'), '# DSH 模式对比\n\nE2E 夹具报告\n');
  writeFileSync(join(reportRoot, goodName, 'evidence.json.gz'), evidenceBytes);
  mkdirSync(join(reportRoot, runningName), { recursive: true });
  writeFileSync(join(reportRoot, runningName, 'experiment.json'), JSON.stringify(runningDocument, null, 2) + '\n');
  mkdirSync(join(reportRoot, pollName), { recursive: true });
  writeFileSync(join(reportRoot, pollName, 'experiment.json'), JSON.stringify(pollDocument, null, 2) + '\n');

  // 出口协议是 API 投影后的形状：用真实 API 的返回值再证一次夹具被接受。
  const listed = await (await request.get('http://127.0.0.1:4318/api/reports')).json() as { directoryName: string; reportId: string; status: string }[];
  const entry = listed.find(item => item.directoryName === goodName);
  expect(entry?.status).toBe('ok');
  const apiDetail = await (await request.get('http://127.0.0.1:4318/api/reports/' + entry!.reportId)).json();
  expect(explainExperimentDetail(apiDetail)).toEqual([]);
  expect(experimentDetailValidator.Check(apiDetail)).toBe(true);
  expect(apiDetail.rows.map((row: { phase: string }) => row.phase)).toEqual(['done', 'done', 'grading', 'solver-stopped', 'pending']);

  await page.goto('/');
  // 在点击页签的同时记录明细请求：列表默认选中第一条，挂载后立即取明细。
  const [firstDetail] = await Promise.all([
    page.waitForResponse(response => response.url().includes('/api/reports/') && !response.url().includes('/artifacts/')),
    page.getByRole('button', { name: /报告中心/ }).click(),
  ]);
  expect(firstDetail.status()).toBe(200);
  await expect(page.getByRole('heading', { name: /报告中心/ })).toBeVisible();
  await expect(page.locator('.experiment-item').first()).toContainText('e2e-fixture-experiment');
  await expect(page.locator('.experiment-item').first()).toContainText('e2e-provider / e2e-model');
  await expect(page.locator('.experiment-item').first()).toContainText('已完成');

  await expect(page.getByRole('heading', { name: /e2e-fixture-experiment/ })).toBeVisible();
  await expect(page.locator('.meta-grid')).toContainText('e2e-provider / e2e-model');
  await expect(page.locator('.meta-grid')).toContainText('5 次 / 1 题');
  await expect(page.locator('.report-detail')).toContainText('已清理');

  // 行级阶段是本页的核心：每条记录都必须给出阶段徽标。
  await expect(page.locator('.rows-table tbody tr')).toHaveCount(5);
  await expect(page.locator('.rows-table tbody')).toContainText('已完成');
  await expect(page.locator('.rows-table tbody')).toContainText('作答中止');
  await expect(page.locator('.rows-table tbody')).toContainText('待作答');
  await expect(page.locator('.rows-table tbody')).toContainText('验证评分中');
  await expect(page.locator('.rows-table tbody tr').first()).toContainText('run-e2e-1/attempt-e2e-1');
  await expect(page.locator('.rows-table tbody tr').first()).toContainText('12.3');
  await expect(page.locator('.phase-summary')).toContainText('已完成 2');

  await expect(page.locator('.timeline li')).toHaveCount(3);
  await expect(page.locator('.timeline')).toContainText('Linux 验证与评分中');
  await expect(page.locator('.report-detail .warn')).toContainText('E2E 夹具问题');

  for (const artifact of ['report', 'experiment', 'evidence', 'log']) {
    await expect(page.locator('.artifact a[href$="/artifacts/' + artifact + '"]')).toBeVisible();
  }
  await expect(page.locator('.artifact-grid')).toContainText(evidenceSha.slice(0, 16));
  await expect(page.locator('.artifact-grid')).toContainText('3 个文件');
  await expect(page.locator('.artifact-grid')).toContainText('launch.log');
  await expect(page.locator('.artifact-grid')).toContainText('404');
  await page.screenshot({ path: testInfo.outputPath('report-center.png'), fullPage: true });

  const reportId = await page.locator('.artifact a[href$="/artifacts/report"]').getAttribute('href').then(href => (href ?? '').split('/')[3] ?? '');
  expect(reportId).not.toBe('');
  const downloaded = await request.get('http://127.0.0.1:4318/api/reports/' + reportId + '/artifacts/report');
  expect(downloaded.status()).toBe(200);
  expect(await downloaded.text()).toContain('E2E 夹具报告');
  // launch.log 当前不存在：404 由页面提示，不崩溃。
  const missing = await request.get('http://127.0.0.1:4318/api/reports/' + reportId + '/artifacts/log');
  expect(missing.status()).toBe(404);

  // 损坏的实验目录：必须仍出现在列表里，写出原因，且页面继续可用。
  mkdirSync(join(reportRoot, brokenName), { recursive: true });
  writeFileSync(join(reportRoot, brokenName, 'experiment.json'), '{ "schemaVersion": "0.3.0", oops');
  await page.getByRole('button', { name: '刷新报告' }).click();
  const broken = page.locator('.experiment-item.broken');
  await expect(page.locator('.experiment-item')).toHaveCount(4);
  await expect(broken).toHaveCount(1);
  await expect(broken).toContainText('不可读');
  await expect(broken).toContainText('不是有效 JSON');

  // 损坏报告不出现在"已完成"筛选里；进行中的实验只出现在"进行中"。
  await page.getByLabel('报告状态', { exact: true }).selectOption('completed');
  await expect(page.locator('.experiment-item')).toHaveCount(1);
  await expect(page.locator('.experiment-item')).toContainText('e2e-fixture-experiment');
  await page.getByLabel('报告状态', { exact: true }).selectOption('running');
  await expect(page.locator('.experiment-item')).toHaveCount(2);
  await expect(page.locator('.experiment-item').first()).toContainText('进行中');
  await page.getByLabel('报告状态', { exact: true }).selectOption('all');
  // 搜索只按关键词命中，不改变损坏报告的可见性。
  await page.getByRole('textbox', { name: '搜索实验' }).fill('e2e-provider');
  await expect(page.locator('.experiment-item')).toHaveCount(1);
  await expect(page.locator('.experiment-item')).not.toContainText('不可读');
  await page.getByRole('textbox', { name: '搜索实验' }).fill('');

  // 回到有效报告：明细仍能取回，损坏报告的错误不会污染右栏。
  await page.locator('.experiment-item').filter({ hasText: 'e2e-fixture-experiment' }).click();
  await expect(page.locator('.rows-table tbody tr')).toHaveCount(5);
  await expect(page.locator('.warn')).toHaveCount(1);

  // 点开损坏报告确实会发出明细请求并拿到 422；页面据此在右栏给出原因而不是白屏。
  const [detailResponse] = await Promise.all([
    page.waitForResponse(response => response.url().includes('/api/reports/') && !response.url().includes('/artifacts/')),
    broken.click(),
  ]);
  expect(detailResponse.status()).toBe(422);
  expect(await detailResponse.text()).toContain('不是有效 JSON');
  await expect(page.locator('.warn.broken')).toContainText('该实验报告不可读');
  await expect(page.locator('.warn.broken')).toContainText('不是有效 JSON');
  await expect(page.locator('.rows-table')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('report-center-unreadable.png'), fullPage: true });

  // 进行中的实验会被 5 秒轮询：明细请求次数必须随时间增长。
  await page.locator('.experiment-item').filter({ hasText: 'e2e-poll-experiment' }).click();
  await expect(page.getByRole('heading', { name: 'e2e-poll-experiment' })).toBeVisible();
  const before = detailRequests.length;
  await page.waitForTimeout(6000);
  expect(detailRequests.length).toBeGreaterThan(before);

  // 状态筛选与搜索都不得把损坏报告藏起来，也不得把进行中的实验混进已完成。
  await page.getByLabel('报告状态', { exact: true }).selectOption('unreadable');
  await expect(page.locator('.experiment-item')).toHaveCount(1);
  await expect(page.locator('.experiment-item')).toContainText('不可读');
  await page.getByLabel('报告状态', { exact: true }).selectOption('all');
  await page.getByRole('textbox', { name: '搜索实验' }).fill('e2e-provider');
  await expect(page.locator('.experiment-item')).toHaveCount(1);
  await page.getByRole('textbox', { name: '搜索实验' }).fill('');
  await expect(page.locator('.experiment-item')).toHaveCount(4);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('report-center-mobile.png'), fullPage: true });
});
