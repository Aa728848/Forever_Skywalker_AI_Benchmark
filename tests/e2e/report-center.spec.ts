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

function evaluation(classification: string | null, runId: string | null, attemptId: string | null, total: number | null, reason?: string) {
  return { environmentKey: 'e2e-environment-key', judgeKey: null, status: { classification, runId, attemptId, evidenceRefs: [],
    scoring: { functional: null, quality: null, total, ...reason === undefined ? {} : { reason } } } };
}

const rows = [
  { taskId: 'CACHE-02', taskVersion: '0.3.0', preset: 'standard', mode: 'off', repetition: 1, sessionId: 'e2e-session-1', phase: 'done', solver: solver('completed', 12340), evaluation: evaluation('passed', 'run-e2e-1', 'attempt-e2e-1', 100), error: null },
  // 第 2 条：作答已完成（phase=done、验证结论 passed）但总分待定——它不是「未完成」，
  // 只是独立评审没通过协议校验（与 exp-2026-09-27T05-09-39-576Z-0c9ca2df 里的 LSP-02 同形）。
  { taskId: 'CACHE-02', taskVersion: '0.3.0', preset: 'standard', mode: 'high', repetition: 1, sessionId: 'e2e-session-2', phase: 'done', solver: solver('completed', 22100),
    evaluation: evaluation('passed', 'run-e2e-2', 'attempt-e2e-2', null, '独立评审未通过协议校验，质量分与总分待定。'), error: null },
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

  /**
   * 行级状态必须把「跑完了」与「分数待定」分开说。
   * 夹具第 2 条是 phase=done 且 total=null：它已经跑完，只是质量分待定。
   * 若把它与真的没跑完的行合并成一句「未完成」，一份 state=completed 的报告就会
   * 看起来还有没跑完的行——这正是要修的问题。
   */
  const rowStates = page.locator('.rows-table tbody tr td:nth-child(6)');
  await expect(rowStates).toHaveCount(5);
  await expect(rowStates.nth(0)).toHaveText('作答完成 · 分数已出');
  await expect(rowStates.nth(1)).toHaveText('作答完成 · 质量分待定');
  await expect(rowStates.nth(2)).toHaveText('还没跑完（验证评分中）');
  await expect(rowStates.nth(3)).toHaveText('还没跑完（作答中止）');
  await expect(rowStates.nth(4)).toHaveText('还没跑完（待作答）');
  // 待定原因必须仍然可见（不为了好看而隐藏），且与「没跑完」那几行区分开。
  // 待定原因必须仍然可见，并且指向真正的原因所在（本页问题区 + 证据包），不隐藏、不编造。
  const pendingRow = page.locator('.rows-table tbody tr').nth(1);
  await expect(pendingRow).toContainText('待定');
  await expect(pendingRow).toContainText('作答已完成（验证结论 passed），却没有数值总分');
  await expect(pendingRow).toContainText('质量证据不完整');
  await expect(pendingRow).toContainText('evidence.json.gz');
  await expect(page.locator('.rows-table tbody')).not.toContainText('未完成');

  // 报告级摘要：三个数各自有标签，不能混成一个「完成度」。
  const summaryGrid = page.locator('.summary-grid');
  await expect(summaryGrid).toContainText('已评分');
  await expect(summaryGrid).toContainText('作答已完成 / 计划');
  await expect(summaryGrid).toContainText('分数待定');
  await expect(summaryGrid).toContainText('还没跑完');
  const tile = (label: string) => summaryGrid.locator('div', { hasText: label }).first().locator('b');
  await expect(tile('已评分')).toHaveText('1 条');
  await expect(tile('作答已完成 / 计划')).toHaveText('2 / 5');
  await expect(tile('分数待定')).toHaveText('1 条');
  await expect(tile('还没跑完')).toHaveText('3 条');
  await expect(page.locator('.field-hint')).toContainText('把待定当成 0 分会把「还不知道」误报成「很差」');

  // 续跑区块：计数与文案分两类，且只对真的没跑完用「未完成」。
  const retry = page.locator('.cleanup-block').filter({ hasText: '续跑只重做两类作答' });
  await expect(retry.locator('li').nth(0)).toContainText('没跑完：3 条');
  await expect(retry.locator('li').nth(1)).toContainText('作答已完成但分数待定：1 条');
  // 按钮文案必须与计数口径一致：两类都要重做时把两个数都写出来，不得用「未完成」指代待定。
  const retryButton = retry.getByRole('button', { name: '续跑 4 条（未完成 3 + 待定 1）…' });
  await expect(retryButton).toHaveText('续跑 4 条（未完成 3 + 待定 1）…');
  await expect(retryButton).toBeEnabled();

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

/**
 * 「报告已完成，却仍说有未完成的行」的回归。
 *
 * 现场：exp-2026-09-27T05-09-39-576Z-0c9ca2df 的 phaseCounts 是 done=55、planned=55、
 * 其余阶段全 0、state=completed；但 LSP-02 的 phase=done 且 total=null（独立评审未通过
 * 协议校验）。旧的 needsRerun = (phase !== 'done' || total === null) 把它与真的没跑完的行
 * 合成一类，于是页面说「续跑未完成的 1 条」并列出一个早已跑完的题。
 *
 * 本用例用一份「2/2 全部跑完且都有分数」的最小报告断言：没有任何「未完成」，
 * 行级状态与续跑文案都不得用「未完成」指代任何东西。
 */
const allDoneName = '2026-09-11T00-00-00-000Z-e2e00005';
const allDoneDocument = {
  ...experimentDocument,
  id: 'e2e-alldone-experiment',
  issues: [],
  rows: [
    { taskId: 'CACHE-02', taskVersion: '0.3.0', preset: 'standard', mode: 'off', repetition: 1, sessionId: 'e2e-done-1', phase: 'done', solver: solver('completed', 11100), evaluation: evaluation('passed', 'run-e2e-d1', 'attempt-e2e-d1', 100), error: null },
    { taskId: 'GRAPH-04', taskVersion: '0.3.0', preset: 'standard', mode: 'off', repetition: 1, sessionId: 'e2e-done-2', phase: 'done', solver: solver('completed', 12300), evaluation: evaluation('passed', 'run-e2e-d2', 'attempt-e2e-d2', 84), error: null },
  ],
};

/**
 * 报告已经跑完、只有个别行分数待定的场景（= 现场 LSP-02 的形状）：
 * 行都 done，其中一条 total=null。此时「未完成」必须为 0，续跑按钮只能说「待定」。
 */
const pendingOnlyName = '2026-09-10T00-00-00-000Z-e2e00006';
const pendingOnlyDocument = {
  ...experimentDocument,
  id: 'e2e-pending-only-experiment',
  issues: [],
  rows: [
    { taskId: 'CACHE-02', taskVersion: '0.3.0', preset: 'standard', mode: 'off', repetition: 1, sessionId: 'e2e-po-1', phase: 'done', solver: solver('completed', 11100), evaluation: evaluation('passed', 'run-e2e-po1', 'attempt-e2e-po1', 100), error: null },
    // 评审未通过协议校验：验证结论仍是 passed，只是没有数值总分。
    { taskId: 'CACHE-02', taskVersion: '0.3.0', preset: 'standard', mode: 'high', repetition: 1, sessionId: 'e2e-po-2', phase: 'done', solver: solver('completed', 22100), evaluation: evaluation('passed', 'run-e2e-po2', 'attempt-e2e-po2', null, '独立评审未通过协议校验，质量分与总分待定。'), error: null },
    // 连验证结论都没登记的行：它是「跑完了但结论缺失」，不是「没跑」——该列不得写成「未评分」。
    { taskId: 'CACHE-02', taskVersion: '0.3.0', preset: 'ptc', mode: 'off', repetition: 1, sessionId: 'e2e-po-3', phase: 'done', solver: solver('completed', 3100), evaluation: null, error: null },
  ],
};

test('行全部跑完、只有分数待定的报告：续跑按钮只说「待定」，不把待定叫成「未完成」', async ({ page }) => {
  mkdirSync(join(reportRoot, pendingOnlyName), { recursive: true });
  writeFileSync(join(reportRoot, pendingOnlyName, 'experiment.json'), JSON.stringify(pendingOnlyDocument, null, 2) + '\n');
  writeFileSync(join(reportRoot, pendingOnlyName, 'report.md'), '# DSH 模式对比\n\n一条待定\n');

  await page.goto('/');
  await page.getByRole('button', { name: /报告中心/ }).click();
  await page.locator('.experiment-item').filter({ hasText: 'e2e-pending-only-experiment' }).click();
  await expect(page.getByRole('heading', { name: 'e2e-pending-only-experiment' })).toBeVisible();

  const rowStates = page.locator('.rows-table tbody tr td:nth-child(6)');
  await expect(rowStates).toHaveCount(3);
  await expect(rowStates.nth(0)).toHaveText('作答完成 · 分数已出');
  await expect(rowStates.nth(1)).toHaveText('作答完成 · 质量分待定');
  await expect(rowStates.nth(2)).toHaveText('作答完成 · 质量分待定');

  // 「验证结论」列只在真的没结论时写「尚无结论」，跑完的行写「结论未登记」——不得读成「没跑」。
  const classifications = page.locator('.rows-table tbody tr td:nth-child(10)');
  await expect(classifications.nth(0)).toHaveText('passed');
  await expect(classifications.nth(1)).toHaveText('passed');
  await expect(classifications.nth(2)).toHaveText('结论未登记');

  const summaryGrid = page.locator('.summary-grid');
  const tile = (label: string) => summaryGrid.locator('div', { hasText: label }).first().locator('b');
  await expect(tile('已评分')).toHaveText('1 条');
  await expect(tile('作答已完成 / 计划')).toHaveText('3 / 3');
  await expect(tile('分数待定')).toHaveText('2 条');
  // 关键：这里「还没跑完」必须是 0，待定不能被算进未完成。
  await expect(tile('还没跑完')).toHaveText('0 条');
  await expect(page.locator('.field-hint')).toContainText('「已经跑完、但总分待定」');
  await expect(page.locator('.field-hint')).toContainText('计划中的作答都已跑完');

  // 待定行的平均分不被当成 0：平均分只由那 1 条已评分作答决定。
  await expect(tile('平均总分')).toHaveText('100.00 /100');

  const retry = page.locator('.cleanup-block').filter({ hasText: '续跑只重做两类作答' });
  await expect(retry.locator('li').nth(0)).toContainText('没跑完：0 条');
  await expect(retry.locator('li').nth(1)).toContainText('作答已完成但分数待定：2 条');
  // 按钮文案必须与计数口径一致：只有待定时说「重跑 … 条待定」，不得出现「未完成」。
  const retryButton = retry.getByRole('button', { name: '重跑 2 条待定…' });
  await expect(retryButton).toBeEnabled();
  await expect(page.locator('.report-detail')).not.toContainText('未完成');
});

test('state=completed 且行全部跑完的报告不得再出现「未完成」或续跑提示', async ({ page }) => {
  mkdirSync(join(reportRoot, allDoneName), { recursive: true });
  writeFileSync(join(reportRoot, allDoneName, 'experiment.json'), JSON.stringify(allDoneDocument, null, 2) + '\n');
  writeFileSync(join(reportRoot, allDoneName, 'report.md'), '# DSH 模式对比\n\n全部跑完\n');

  await page.goto('/');
  await page.getByRole('button', { name: /报告中心/ }).click();
  await page.locator('.experiment-item').filter({ hasText: 'e2e-alldone-experiment' }).click();
  await expect(page.getByRole('heading', { name: 'e2e-alldone-experiment' })).toBeVisible();

  // 每条作答都已完成且有分数：行级状态只说这一件事。
  const rowStates = page.locator('.rows-table tbody tr td:nth-child(6)');
  await expect(rowStates).toHaveCount(2);
  await expect(rowStates.nth(0)).toHaveText('作答完成 · 分数已出');
  await expect(rowStates.nth(1)).toHaveText('作答完成 · 分数已出');

  const summaryGrid = page.locator('.summary-grid');
  const tile = (label: string) => summaryGrid.locator('div', { hasText: label }).first().locator('b');
  await expect(tile('已评分')).toHaveText('2 条');
  await expect(tile('作答已完成 / 计划')).toHaveText('2 / 2');
  await expect(tile('分数待定')).toHaveText('0 条');
  await expect(tile('还没跑完')).toHaveText('0 条');
  await expect(page.locator('.field-hint')).toContainText('计划中的作答都已跑完');
  await expect(page.locator('.field-hint')).toContainText('三个不同的数');

  // 核心断言：整份报告明细里不再出现「未完成」，续跑按钮也明确说没有需要重做的。
  await expect(page.locator('.report-detail')).not.toContainText('未完成');
  const retry = page.locator('.cleanup-block').filter({ hasText: '续跑只重做两类作答' });
  await expect(retry.locator('li').nth(0)).toContainText('没跑完：0 条');
  await expect(retry.locator('li').nth(1)).toContainText('作答已完成但分数待定：0 条');
  await expect(retry).toContainText('没有需要重做的');
  const retryButton = retry.getByRole('button', { name: /^续跑/ });
  await expect(retryButton).toHaveText('续跑（没有需要重做的作答）…');
  await expect(retryButton).toBeDisabled();
  await expect(page.locator('.rows-table tbody')).not.toContainText('未完成');
});

test('进度日志默认收起：长日志不撑开报告详情，点开才渲染条目', async ({ page }) => {
  // 一份 120 条的实验：真实上限是 500 条（comparisonProgressLimit），全展开会把「逐条作答」表挤出视野。
  const many = Array.from({ length: 120 }, (_, index) => ({
    at: '2026-09-14T00:' + String(Math.floor(index / 60)).padStart(2, '0') + ':' + String(index % 60).padStart(2, '0') + '.000Z',
    message: 'CACHE-02 · ptc / max · 第 1 次：DSH 作答中 (' + String(index) + ')',
  }));
  const document = { ...experimentDocument, id: 'e2e-long-progress', progress: many,
    settings: { ...experimentDocument.settings, provider: 'e2e-long-provider', model: 'e2e-long-model' } };
  const name = '2026-09-11T00-00-00-000Z-e2e00005';
  mkdirSync(join(reportRoot, name), { recursive: true });
  writeFileSync(join(reportRoot, name, 'experiment.json'), JSON.stringify(document, null, 2) + String.fromCharCode(10));

  await page.goto('/');
  await page.getByRole('button', { name: /报告中心/ }).click();
  await page.locator('.report-item').filter({ hasText: 'e2e-long-progress' }).click();

  const log = page.locator('details.progress-log');
  await expect(log).toHaveCount(1);
  await expect(log).toContainText('120 条');
  // 收起时整个实验一条进度条目都不许出现在 DOM 里——是「不渲染」，不是 CSS 隐藏。
  // 用 DOM 布尔值而不是属性字符串：React 把 open={true} 渲染成 open=""，
  // 断言属性文本会分不清「空属性的 true」与「属性缺失的 false」。
  expect(await log.evaluate(node => (node as HTMLDetailsElement).open)).toBe(false);
  await expect(page.locator('.timeline li')).toHaveCount(0);
  await expect(log).toContainText('点击展开');

  await log.locator('summary').click();
  expect(await log.evaluate(node => (node as HTMLDetailsElement).open)).toBe(true);
  await expect(page.locator('.timeline li')).toHaveCount(120);
  await expect(page.locator('.timeline')).toContainText('DSH 作答中 (119)');

  // 再点一次收起，条目重新从 DOM 消失。
  await log.locator('summary').click();
  await expect(page.locator('.timeline li')).toHaveCount(0);
});