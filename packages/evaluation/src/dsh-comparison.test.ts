import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createEnvelope } from '@fsa/runs';
import { readRunStatus, verifySubmission } from '@fsa/executor';
import { applyReferencePatch, readManifest } from '@fsa/tasks';
import { inspectRunSelection } from './suite.ts';
import { DshCleanupError, type DshRunOptions, type DshRunResult } from './dsh.ts';
import { comparisonGroups, renderComparison, runDshComparison, type DshComparisonOptions } from './dsh-comparison.ts';

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

it('错误、超时和取消保留为未评分，取消后不启动剩余作答', async () => {
  const context = setup();
  const controller = new AbortController();
  let calls = 0;
  try {
    const report = await runDshComparison(context.options, { signal: controller.signal, env: {},
      async solve(options) {
        calls++;
        if (calls === 3) controller.abort();
        return solverResult(options, calls === 1 ? 'error' : calls === 2 ? 'timeout' : 'cancelled');
      },
      async evaluate() { throw new Error('未完成的作答不应触发评分'); },
    });
    expect(report.state).toBe('cancelled'); expect(calls).toBe(3);
    expect(report.rows.map(row => row.phase)).toEqual(['solver-stopped', 'solver-stopped', 'solver-stopped', 'pending']);
    expect(comparisonGroups(report).groups.every(group => group.total === null && group.graded === 0 && group.planned === 2)).toBe(true);
  } finally { context.clean(); }
});

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
