import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createEnvelope, type RunStore } from '@fsa/runs';
import { readRunStatus, verifySubmission } from '@fsa/executor';
import { applyReferencePatch, readManifest } from '@fsa/tasks';
import { inspectRunSelection } from './suite.ts';
import { DshCleanupError, type DshRunOptions, type DshRunResult } from './dsh.ts';
import { appendComparisonProgress, comparisonGroups, comparisonProgressLimit, renderComparison, runDshComparison, type DshComparisonOptions, type DshComparisonReport } from './dsh-comparison.ts';

function setup() {
  const scratch = mkdtempSync(join(tmpdir(), 'fsa-dsh-comparison-test-'));
  const options: DshComparisonOptions = {
    dshRoot: join(scratch, 'unused-sdk'), dshHome: join(scratch, 'unused-home'), profile: 'sdk', workspacePermission: 'workspace-write',
    provider: 'scripted', model: 'fixture-test-only', presets: ['standard'], modes: ['off', 'high'], taskIds: ['CACHE-02'], repeats: 2,
    maxTokens: 1024, timeoutMs: 1000, outputDirectory: join(scratch, 'experiment'),
    image: 'unused-test-image', imageDigest: 'sha256:' + '0'.repeat(64), measurePerformance: false,
  };
  return { scratch, options, clean() {
    const target = resolve(scratch);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('fsa-dsh-comparison-test-')) throw new Error('测试清理越界。');
    rmSync(target, { recursive: true, force: true });
  } };
}

it('受控启动已认领的空报告目录可直接使用，非空目录仍被拒绝覆盖', async () => {
  // 回归：网页发起测评时，dsh-compare.ts 的 --experiment-id 分支先用
  // mkdirSync(recursive:false) 原子认领报告目录，随后 runDshComparison 又无条件
  // mkdirSync 同一路径，必然 EEXIST 退出——受控启动因此从未成功过。
  // 修复后只区分：空目录是调用方刚认领的（可用），非空目录才是既有实验（拒绝覆盖）。
  const refused = setup();
  const refusedDir = refused.options.outputDirectory;
  mkdirSync(refusedDir, { recursive: true });
  writeFileSync(join(refusedDir, 'report.md'), '既有实验');
  try {
    await expect(runDshComparison(refused.options, { solve: async o => solverResult(o) })).rejects.toThrow(/非空|拒绝覆盖/);
    // 既有内容必须原样保留，不能被本次运行改写。
    expect(readdirSync(refusedDir)).toEqual(['report.md']);
    expect(readFileSync(join(refusedDir, 'report.md'), 'utf8')).toBe('既有实验');
  } finally { refused.clean(); }

  // 已认领的空目录必须能跑完整条链路（这正是网页发起测评的路径，此前从未成功过）。
  const claimed = setup();
  mkdirSync(claimed.options.outputDirectory, { recursive: true });
  try {
    const report = await runDshComparison(claimed.options, {
      env: {},
      async solve(options) { return solverResult(options); },
      async evaluate(taskId, workspace, row, store) {
        const outcome = await verifySubmission({ store, taskId, candidateDirectory: workspace,
          envelope: createEnvelope(taskId, workspace), submittedBy: 'scripted-' + row.mode, profile: 'local' });
        const { runId, attemptId } = outcome.submission.attempt;
        const identity = inspectRunSelection(store, [{ runId, attemptId }]);
        return { status: readRunStatus(store, runId, attemptId), environmentKey: identity.environmentKey, judgeKey: identity.judgeKey };
      },
    });
    expect(report.state).toBe('completed');
    // 三个产物必须落进调用方已认领的目录。
    expect(readdirSync(claimed.options.outputDirectory).sort()).toEqual(['evidence.json.gz', 'experiment.json', 'report.md']);
  } finally { claimed.clean(); }
}, 20_000);
function solverResult(options: DshRunOptions, finishReason = 'completed'): DshRunResult {
  return { finishReason, durationMs: 1, finalResponse: '模拟作答，仅测试编排', usage: null,
    requestedModel: { provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort === 'default' ? null : options.reasoningEffort, maxTokens: options.maxTokens },
    requestedPreset: options.agentPreset ?? 'standard', observedPresets: [options.agentPreset ?? 'standard'], presetFingerprint: 'f'.repeat(64),
    observedRoutes: [], responseModels: [], dshVersion: 'scripted-test-only', runtimeClosed: true, cleanupScope: 'sdk-runtime' };
}

it('独立导出、反转重复顺序，模拟作答经真实验证，并保留失败与待评分项', async () => {
  const context = setup();
  try {
    const workspaces = new Set<string>();
    const sessions = new Set<string>();
    const initialSources: string[] = [];
    const report = await runDshComparison(context.options, {
      env: {},
      async solve(options) {
        workspaces.add(options.workspace); sessions.add(options.sessionId);
        expect(options.workspacePermission).toBe('workspace-write');
        expect(existsSync(join(options.workspace, 'TASK.md'))).toBe(true);
        expect(existsSync(join(options.workspace, 'graders'))).toBe(false);
        initialSources.push(readFileSync(join(options.workspace, 'starter/src/keyed-loader.ts'), 'utf8'));
        if (options.reasoningEffort === 'high') expect(applyReferencePatch(readManifest('CACHE-02'), options.workspace, join(context.scratch, 'patch')).exitCode).toBe(0);
        return solverResult(options);
      },
      async evaluate(taskId, workspace, row, store) {
        const outcome = await verifySubmission({ store, taskId, candidateDirectory: workspace,
          envelope: createEnvelope(taskId, workspace), submittedBy: 'scripted-' + row.mode, profile: 'local' });
        const { runId, attemptId } = outcome.submission.attempt;
        const identity = inspectRunSelection(store, [{ runId, attemptId }]);
        return { status: readRunStatus(store, runId, attemptId), environmentKey: identity.environmentKey, judgeKey: identity.judgeKey };
      },
    });
    expect(report.state).toBe('completed');
    expect(report.rows.map(row => row.mode)).toEqual(['off', 'high', 'high', 'off']);
    expect(workspaces.size).toBe(4); expect(sessions.size).toBe(4);
    expect(new Set(initialSources).size).toBe(1);
    expect([...workspaces].every(path => !existsSync(path))).toBe(true);
    expect(report.cleanup).toMatchObject({ state: 'complete', directory: null });
    expect(readdirSync(context.options.outputDirectory).sort()).toEqual(['evidence.json.gz', 'experiment.json', 'report.md']);
    const archive = JSON.parse(gunzipSync(readFileSync(join(context.options.outputDirectory, 'evidence.json.gz'))).toString()) as { files: { path: string }[] };
    for (const row of report.rows) expect(archive.files.some(file => file.path.includes(row.evaluation!.status.attemptId) && file.path.endsWith('score.json'))).toBe(true);
    expect(archive.files.some(file => file.path.startsWith('answers/') && file.path.endsWith('keyed-loader.ts'))).toBe(true);
    const groups = comparisonGroups(report).groups;
    expect(groups.find(group => group.mode === 'high')).toMatchObject({ planned: 2, completed: 2, passed: 2, functional: 50, quality: null, total: null });
    expect(groups.find(group => group.mode === 'off')).toMatchObject({ planned: 2, completed: 2, passed: 0, graded: 2, total: null });
    expect(groups.find(group => group.mode === 'off')!.functional).toBeLessThan(50);
    expect(JSON.parse(readFileSync(join(context.options.outputDirectory, 'experiment.json'), 'utf8')).rows).toHaveLength(4);
    expect(JSON.parse(readFileSync(join(context.options.outputDirectory, 'experiment.json'), 'utf8')).settings.workspacePermission).toBe('workspace-write');
    expect(readFileSync(join(context.options.outputDirectory, 'report.md'), 'utf8')).toContain('工作区权限：workspace-write');
    const drifted = structuredClone(report);
    drifted.rows[0]!.evaluation!.judgeKey = 'judge-a'; drifted.rows[1]!.evaluation!.judgeKey = 'judge-b';
    expect(comparisonGroups(drifted).drift).toContain('裁判配置或实际模型不一致');
    expect(comparisonGroups(drifted).groups.every(group => group.functional === null && group.total === null)).toBe(true);
    const missing = structuredClone(report);
    missing.rows[1]!.evaluation = null;
    expect(comparisonGroups(missing).groups.find(group => group.mode === 'high')!.functional).toBeNull();
    const presetDrift = structuredClone(report);
    presetDrift.rows[0]!.solver!.presetFingerprint = 'changed';
    expect(comparisonGroups(presetDrift).drift).toContain('DSH standard 预设内容发生变化');
    const providerDefault = structuredClone(report);
    providerDefault.settings.modes = ['off', 'default'];
    for (const row of providerDefault.rows) if (row.mode === 'high') {
      row.mode = 'default'; row.solver!.requestedModel.reasoningEffort = null;
    }
    expect(comparisonGroups(providerDefault).drift).toEqual([]);
    expect(comparisonGroups(providerDefault).groups.find(group => group.mode === 'default')).toMatchObject({ functional: 50, planned: 2 });
    expect(comparisonGroups(providerDefault).groups.find(group => group.mode === 'off')!.functional).toBeLessThan(50);
    expect(renderComparison(providerDefault)).toContain('default 表示未向 DSH 指定思考等级');
  } finally { context.clean(); }
}, 30_000);

it('进度只追加落盘、最多保留最近 500 条，报告与 Markdown 都按原子替换写入', async () => {
  const context = setup();
  const seen: string[] = [];
  try {
    const report = await runDshComparison({ ...context.options, repeats: 1 }, {
      env: {}, onProgress: message => seen.push(message), async solve(options) { return solverResult(options); },
      async evaluate(taskId, workspace, _row, store) {
        const outcome = await verifySubmission({ store, taskId, candidateDirectory: workspace,
          envelope: createEnvelope(taskId, workspace), submittedBy: 'progress-test', profile: 'local' });
        const { runId, attemptId } = outcome.submission.attempt;
        const identity = inspectRunSelection(store, [{ runId, attemptId }]);
        return { status: readRunStatus(store, runId, attemptId), environmentKey: identity.environmentKey, judgeKey: identity.judgeKey };
      },
    });
    expect(report.schemaVersion).toBe('0.3.0');
    // 两道作答（off/high）各产生两条进度，且与 CLI 打印的内容一致。
    expect(seen).toEqual(['CACHE-02 · standard / off · 第 1 次：DSH 作答中', 'CACHE-02 · standard / off：Linux 验证与评分中',
      'CACHE-02 · standard / high · 第 1 次：DSH 作答中', 'CACHE-02 · standard / high：Linux 验证与评分中']);
    expect(report.progress.map(entry => entry.message)).toEqual(seen);
    expect(report.progress.every(entry => !Number.isNaN(Date.parse(entry.at)))).toBe(true);
    const persisted = JSON.parse(readFileSync(join(context.options.outputDirectory, 'experiment.json'), 'utf8')) as DshComparisonReport;
    expect(persisted.progress).toEqual(report.progress);
    // 只有三个产物，且没有留下 .tmp：临时文件必须已经改名。
    expect(readdirSync(context.options.outputDirectory).sort()).toEqual(['evidence.json.gz', 'experiment.json', 'report.md']);
  } finally { context.clean(); }

  // 上限：超出时丢弃最旧的，experiment.json 不随实验时长无界增长。
  const overflow = structuredClone({ progress: [] } as unknown as DshComparisonReport);
  for (let index = 0; index < comparisonProgressLimit + 25; index++) appendComparisonProgress(overflow, `进度 ${index}`, '2026-09-14T00:00:00.000Z');
  expect(overflow.progress).toHaveLength(comparisonProgressLimit);
  expect(overflow.progress[0]!.message).toBe('进度 25');
  expect(overflow.progress.at(-1)!.message).toBe(`进度 ${comparisonProgressLimit + 24}`);
}, 30_000);

it('相同思考等级下不同 DSH 预设分别评分，指定模型透传且不混合均分', async () => {
  const context = setup();
  try {
    const report = await runDshComparison({ ...context.options, presets: ['standard', 'ptc'], modes: ['high'], repeats: 1 }, {
      env: {},
      async solve(options) {
        expect(options.model).toBe('fixture-test-only'); expect(options.reasoningEffort).toBe('high');
        expect(options.workspacePermission).toBe('workspace-write');
        if (options.agentPreset === 'ptc') expect(applyReferencePatch(readManifest('CACHE-02'), options.workspace, join(context.scratch, 'patch')).exitCode).toBe(0);
        return { ...solverResult(options), presetFingerprint: options.agentPreset === 'ptc' ? 'ptc-fixture' : 'standard-fixture' };
      },
      async evaluate(taskId, workspace, row, store) {
        const outcome = await verifySubmission({ store, taskId, candidateDirectory: workspace,
          envelope: createEnvelope(taskId, workspace), submittedBy: 'preset-test-' + row.preset, profile: 'local' });
        const { runId, attemptId } = outcome.submission.attempt;
        const identity = inspectRunSelection(store, [{ runId, attemptId }]);
        return { status: readRunStatus(store, runId, attemptId), environmentKey: identity.environmentKey, judgeKey: identity.judgeKey };
      },
    });
    const { groups, drift } = comparisonGroups(report);
    expect(report.state).toBe('completed'); expect(drift).toEqual([]); expect(groups).toHaveLength(2);
    expect(groups.find(group => group.preset === 'ptc')).toMatchObject({ mode: 'high', functional: 50, planned: 1 });
    expect(groups.find(group => group.preset === 'standard')!.functional).toBeLessThan(50);
    expect(report.cleanup.state).toBe('complete');
  } finally { context.clean(); }
}, 30_000);

it('续跑只补跑未完成与待定的行，已落定的分数原样保留', async () => {
  // 回归（真实故障 exp-2026-09-26T11-21-31-129Z-32e16e34）：
  // 55 题里 5 题从未作答、1 题因 EPERM 中断，另有 3 题的 phase 是 'done'
  // 但 scoring.total 为 null（作答完成、评分待定）。
  // 关键：待定行的 phase 同样是 'done'。若只按 phase 判断「已落定」，
  // 续跑会把它们跳过，待定就永久留在报告里——这正是必须补跑的一类。
  const context = setup();
  // 本夹具没有裁判，所以 verifySubmission 得到的总分天然是 null。
  // 续跑测试需要一个「这次能给出判决」的裁判——用 scoring 上的数值总分模拟，
  // 这样「续跑后不再有待定」才是被验证的事实，而不是夹具的偶然形态。
  const evaluateScored = async (taskId: string, workspace: string, row: { mode: string; sessionId: string }, store: RunStore) => {
    const outcome = await verifySubmission({ store, taskId, candidateDirectory: workspace,
      envelope: createEnvelope(taskId, workspace, { idempotencyKey: row.sessionId }), submittedBy: 'scripted-' + row.mode, profile: 'local' });
    const { runId, attemptId } = outcome.submission.attempt;
    const identity = inspectRunSelection(store, [{ runId, attemptId }]);
    const status = readRunStatus(store, runId, attemptId);
    status.scoring.quality = 45;
    status.scoring.total = 95;
    return { status, environmentKey: identity.environmentKey, judgeKey: identity.judgeKey };
  };
  try {
    // 第一轮：正常跑完并全部落定（4 条行 = 1 题 × 2 模式 × 2 次）。
    const first = await runDshComparison(context.options, { env: {}, async solve(o) { return solverResult(o); }, evaluate: evaluateScored });
    expect(first.state).toBe('completed');
    expect(first.rows).toHaveLength(4);
    expect(first.rows.every(r => typeof r.evaluation?.status?.scoring?.total === 'number')).toBe(true);

    // 把报告塑造成真实形态（exp-2026-09-26T11-21-31-129Z-32e16e34 的现场）：
    //  · 第 0、1 条 -> 保持落定（续跑必须原样保留、绝不重跑）
    //  · 第 2 条     -> phase='done' 但总分为 null（作答完成、评分待定）
    //  · 第 3 条     -> 从未作答
    const pendingRow = first.rows[2]!;
    pendingRow.evaluation!.status.scoring.quality = null;
    pendingRow.evaluation!.status.scoring.total = null;
    const neverRan = first.rows[3]!;
    neverRan.phase = 'pending'; neverRan.solver = null; neverRan.evaluation = null;
    writeFileSync(join(context.options.outputDirectory, 'experiment.json'), JSON.stringify(first, null, 2) + '\n');
    const settledIndexes = [0, 1];
    const totalsBefore = first.rows.map(r => r.evaluation?.status?.scoring?.total ?? null);
    // 第二轮：续跑。只应重跑那两条，落定行的分数一个都不许变。
    const executed: string[] = [];
    const second = await runDshComparison({ ...context.options, resume: true }, { env: {},
      async solve(o) { executed.push(o.sessionId); return solverResult(o); },
      evaluate: evaluateScored });
    expect(second.state).toBe('completed');
    // 只重跑了 2 条（待定 + 未作答），而不是全部 4 条。
    expect(executed).toHaveLength(2);
    expect(executed).not.toContain(first.rows[0]!.sessionId);
    expect(executed).not.toContain(first.rows[1]!.sessionId);
    // 落定行的分数原样保留。
    for (const i of settledIndexes) {
      expect(second.rows[i]!.sessionId).toBe(first.rows[i]!.sessionId);
      expect(second.rows[i]!.evaluation?.status?.scoring?.total).toBe(totalsBefore[i]);
    }
    // 关键断言：续跑后没有「已完成却待定」的行留存。
    expect(second.rows.filter(r => r.evaluation !== null && typeof r.evaluation.status.scoring.total !== 'number')).toEqual([]);
    // 续跑说明写进报告，可审计。
    expect(second.issues.join(' ')).toContain('续跑');
  } finally { context.clean(); }
}, 30_000);
it('续跑拒绝与既有报告不一致的配置，避免把两套配置的分数混进一份报告', async () => {
  const context = setup();
  const evaluateOnce = async (taskId: string, workspace: string, row: { mode: string; sessionId: string }, store: RunStore) => {
    const outcome = await verifySubmission({ store, taskId, candidateDirectory: workspace,
      envelope: createEnvelope(taskId, workspace, { idempotencyKey: row.sessionId }), submittedBy: 'scripted-' + row.mode, profile: 'local' });
    const { runId, attemptId } = outcome.submission.attempt;
    const identity = inspectRunSelection(store, [{ runId, attemptId }]);
    return { status: readRunStatus(store, runId, attemptId), environmentKey: identity.environmentKey, judgeKey: identity.judgeKey };
  };
  try {
    await runDshComparison(context.options, { env: {}, async solve(o) { return solverResult(o); }, evaluate: evaluateOnce });
    await expect(runDshComparison({ ...context.options, resume: true, model: 'another-model' }, { env: {}, async solve(o) { return solverResult(o); } }))
      .rejects.toThrow(/续跑配置与既有报告不一致（model）/);
    // 目标不存在时也要明确拒绝。
    await expect(runDshComparison({ ...context.options, resume: true, outputDirectory: join(context.scratch, 'nope') }, { env: {} }))
      .rejects.toThrow(/续跑要求报告目录里已有 experiment.json/);
  } finally { context.clean(); }
}, 30_000);
it('并行度 N 真的让 N 条作答同时在飞，并缩短墙钟', async () => {
  // 直接证据：记录「同时在飞」的峰值。串行时峰值恒为 1。
  const measure = async (concurrency: number) => {
    const context = setup();
    try {
      let inFlight = 0; let peak = 0;
      const started = Date.now();
      const report = await runDshComparison({ ...context.options, taskIds: ['CACHE-02', 'CACHE-03', 'CACHE-04'], repeats: 1, modes: ['off'], concurrency },
        { env: {},
          async solve(options) {
            inFlight += 1; peak = Math.max(peak, inFlight);
            await new Promise(resolve => setTimeout(resolve, 120));
            inFlight -= 1;
            return solverResult(options);
          },
          async evaluate(taskId, workspace, row, store) {
            inFlight += 1; peak = Math.max(peak, inFlight);
            await new Promise(resolve => setTimeout(resolve, 120));
            inFlight -= 1;
            const outcome = await verifySubmission({ store, taskId, candidateDirectory: workspace,
              envelope: createEnvelope(taskId, workspace, { idempotencyKey: row.sessionId }), submittedBy: 'scripted-' + row.mode, profile: 'local' });
            const { runId, attemptId } = outcome.submission.attempt;
            const identity = inspectRunSelection(store, [{ runId, attemptId }]);
            return { status: readRunStatus(store, runId, attemptId), environmentKey: identity.environmentKey, judgeKey: identity.judgeKey };
          },
        });
      return { peak, elapsed: Date.now() - started, state: report.state, rows: report.rows.length };
    } finally { context.clean(); }
  };
  const serial = await measure(1);
  const parallel = await measure(3);
  // 串行峰值必须是 1；3 路必须达到 3。
  expect(serial.peak).toBe(1);
  expect(parallel.peak).toBe(3);
  // 三条各睡 240ms（solve+evaluate），3 路应显著快于串行。
  expect(parallel.elapsed).toBeLessThan(serial.elapsed);
  // 并行不改变结果完整性。
  expect(parallel.state).toBe('completed');
  expect(parallel.rows).toBe(3);
}, 40_000);
it('作答未完成（错误/超时）仍按 0 分验证；取消才停止且不再启动剩余作答', async () => {
  // 用户决定：超时等「被测失败」要走进验证并按 0 分计，不再留成待定——
  // 待定会让一次实验出现大量没有成绩的行。只有**取消**才真的没有结论。
  const context = setup();
  const controller = new AbortController();
  let calls = 0;
  const verified: string[] = [];
  try {
    const report = await runDshComparison(context.options, { signal: controller.signal, env: {},
      async solve(options) {
        calls++;
        if (calls === 3) controller.abort();
        return solverResult(options, calls === 1 ? 'error' : calls === 2 ? 'timeout' : 'cancelled');
      },
      async evaluate(taskId, workspace, row, store) {
        verified.push(row.taskId);
        const outcome = await verifySubmission({ store, taskId, candidateDirectory: workspace,
          envelope: createEnvelope(taskId, workspace, { idempotencyKey: row.sessionId }), submittedBy: 'scripted-' + row.mode, profile: 'local' });
        const { runId, attemptId } = outcome.submission.attempt;
        const identity = inspectRunSelection(store, [{ runId, attemptId }]);
        return { status: readRunStatus(store, runId, attemptId), environmentKey: identity.environmentKey, judgeKey: identity.judgeKey };
      },
    });
    expect(report.state).toBe('cancelled'); expect(calls).toBe(3);
    // 前两条（error / timeout）走了验证并落定；第三条是取消，保持未评分；第四条从未启动。
    expect(report.rows.map(row => row.phase)).toEqual(['done', 'done', 'solver-stopped', 'pending']);
    expect(verified).toHaveLength(2);
    // 取消之后不再启动剩余作答：计划 4 条，只跑了 3 条。
    expect(comparisonGroups(report).groups.every(group => group.planned === 2)).toBe(true);
  } finally { context.clean(); }
});

it('单题作答失败不中止整轮：其余题照常完成，实验不再 failed', async () => {
  // 回归（2026-09-27）：一次 55 题实验里 LSP-04 报「initialize timed out」后，
  // 整轮被中止，其余 51 题全部停在 pending、state=failed。
  // 用户要求：出现错误或超时不应阻断后续测评。
  const context = setup();
  let calls = 0;
  try {
    const report = await runDshComparison({ ...context.options, taskIds: ['CACHE-02', 'CACHE-03', 'CACHE-04'], repeats: 1, modes: ['off'] },
      { env: {},
        async solve(options) {
          calls += 1;
          // 第 2 题抛错（模拟初始化超时这类单题故障），其余正常。
          if (calls === 2) throw new Error('initialize timed out after 10000ms waiting for dsh profile "sdk"');
          return solverResult(options);
        },
        async evaluate(taskId, workspace, row, store) {
          const outcome = await verifySubmission({ store, taskId, candidateDirectory: workspace,
            envelope: createEnvelope(taskId, workspace, { idempotencyKey: row.sessionId }), submittedBy: 'scripted-' + row.mode, profile: 'local' });
          const { runId, attemptId } = outcome.submission.attempt;
          const identity = inspectRunSelection(store, [{ runId, attemptId }]);
          return { status: readRunStatus(store, runId, attemptId), environmentKey: identity.environmentKey, judgeKey: identity.judgeKey };
        },
      });
    // 关键：整轮仍然完成，不是 failed；且没有留下未作答的行。
    expect(report.state).toBe('completed');
    expect(calls).toBe(3);
    const failed = report.rows.filter(row => row.phase === 'error');
    expect(failed).toHaveLength(1);
    // 失败原因如实记录在那一行上，不伪装成正常成绩。
    expect(failed[0]!.error).toContain('initialize timed out');
    // 其余两题照常完成（不再被中止）。
    expect(report.rows.filter(row => row.phase === 'done')).toHaveLength(2);
  } finally { context.clean(); }
}, 30_000);
it('运行时回收或初始化失败后落盘失败记录并阻止新的模型调用', async () => {
  const context = setup();
  let calls = 0;
  let retained: string | null = null;
  try {
    const report = await runDshComparison(context.options, { env: {}, async solve() { calls++; throw new DshCleanupError([new Error('fake close error')], 'DSH 运行时回收未确认'); } });
    retained = report.cleanup.directory;
    expect(calls).toBe(1); expect(report.state).toBe('failed');
    expect(report.rows[0]!.error).toContain('回收未确认');
    expect(report.rows.slice(1).every(row => row.phase === 'pending')).toBe(true);
    expect(JSON.parse(readFileSync(join(context.options.outputDirectory, 'experiment.json'), 'utf8')).state).toBe('failed');
    expect(report.cleanup.state).toBe('retained'); expect(retained && existsSync(retained)).toBe(true);
  } finally {
    if (retained) {
      const target = resolve(retained);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('fsa-dsh-experiment-')) throw new Error('测试保留目录越界。');
      rmSync(target, { recursive: true, force: true });
    }
    context.clean();
  }
});

it('最后一次评分返回时已取消，保留分数但不能把实验误标完成', async () => {
  const context = setup();
  const controller = new AbortController();
  try {
    const report = await runDshComparison({ ...context.options, repeats: 1 }, {
      env: {}, signal: controller.signal, solve: async options => solverResult(options),
      async evaluate(taskId, workspace, row, store) {
        const outcome = await verifySubmission({ store, taskId, candidateDirectory: workspace,
          envelope: createEnvelope(taskId, workspace), submittedBy: 'cancel-test', profile: 'local' });
        const { runId, attemptId } = outcome.submission.attempt;
        const identity = inspectRunSelection(store, [{ runId, attemptId }]);
        if (row.mode === 'high') controller.abort();
        return { status: readRunStatus(store, runId, attemptId), environmentKey: identity.environmentKey, judgeKey: identity.judgeKey };
      },
    });
    expect(report.state).toBe('cancelled');
    expect(report.rows.at(-1)!.evaluation?.status.scoring.functional).not.toBeNull();
    expect(JSON.parse(readFileSync(join(context.options.outputDirectory, 'experiment.json'), 'utf8')).state).toBe('cancelled');
  } finally { context.clean(); }
}, 30_000);