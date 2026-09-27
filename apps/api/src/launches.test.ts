import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import { createConfigProvider } from './config.ts';
import { LaunchError, createLaunches, mergeState, type LaunchView } from './launches.ts';
import { processStartTime } from '../../../scripts/experiment-supervisor.ts';

/**
 * 自动测评启动层的测试。
 *
 * supervisor 本体是真实的 scripts/experiment-supervisor.ts，被监督的子进程是一个睡眠/退出的 .mjs 假脚本。
 * 全程不调用真实模型、不调用裁判、不启动 Linux 容器。
 */

const repositoryRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const supervisorScript = join(repositoryRoot, 'scripts', 'experiment-supervisor.ts');
const token = 'launch-test-token';
const scratchRoots: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'fsa-api-launches-'));
  scratchRoots.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of scratchRoots.splice(0)) {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('fsa-api-launches-')) throw new Error('测试清理越界。');
    rmSync(target, { recursive: true, force: true });
  }
});

const wait = (ms: number): Promise<void> => new Promise(resolvePromise => setTimeout(resolvePromise, ms));

/** 轮询直到条件成立；超时即失败并附带最后一次观察到的值。 */
async function until<T>(probe: () => T | null | undefined | false, timeoutMs = 20_000, label = '条件'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== null && value !== undefined && value !== false) return value as T;
    last = value;
    await wait(25);
  }
  throw new Error(label + ' 未在 ' + timeoutMs + 'ms 内成立；最后一次观察：' + JSON.stringify(last));
}

function isAlive(pid: number | null): boolean {
  if (pid === null) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const readJson = (path: string): Record<string, unknown> | null => {
  try { return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>; } catch { return null; }
};

/**
 * 假作答脚本：先落下回执（含自己读到的 supervisor 令牌与启动记录状态），按需拉起一个孙进程，然后睡眠并退出。
 * 孙进程以普通子进程方式启动（不脱离进程组），因此 taskkill /t 或进程组终止能覆盖到它。
 */
const fakeChild = `import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const record = process.env.BENCH_LAUNCH_RECORD;
if (process.env.FAKE_CHILD_LOG) writeFileSync(process.env.FAKE_CHILD_LOG, JSON.stringify({
  pid: process.pid, argv: process.argv.slice(2),
  token: process.env.BENCH_SUPERVISOR_TOKEN ?? null,
  heartbeatAt: record ? (JSON.parse(readFileSync(record, 'utf8')).heartbeatAt ?? null) : null,
  state: record ? (JSON.parse(readFileSync(record, 'utf8')).state ?? null) : null,
}, null, 2) + '\\n');
if (process.env.FAKE_GRANDCHILD_LOG && process.env.FAKE_GRANDCHILD_SCRIPT) {
  const grandchild = spawn(process.execPath, [process.env.FAKE_GRANDCHILD_SCRIPT], { stdio: 'ignore' });
  writeFileSync(process.env.FAKE_GRANDCHILD_LOG, String(grandchild.pid) + '\\n');
}
await new Promise(r => setTimeout(r, Number(process.env.FAKE_SLEEP_MS ?? '300')));
process.exit(Number(process.env.FAKE_EXIT_CODE ?? '0'));
`;

interface Harness {
  root: string;
  launchesRoot: string;
  outputRoot: string;
  childPath: string;
  childLog: string;
  grandchildLog: string;
  grandchildScript: string;
  launches: ReturnType<typeof createLaunches>;
  baseEnv: NodeJS.ProcessEnv;
  config: ReturnType<typeof createConfigProvider>;
}

interface HarnessOptions {
  heartbeatMs?: number;
  leaseTtlMs?: number;
  confirmMs?: number;
  registrationWaitMs?: number;
  /** 让假子进程再拉起一个孙进程（窗口三用），同时把睡眠时间拉长到 8 秒。 */
  grandchild?: boolean;
  sleepMs?: number;
}

function harness(options: HarnessOptions = {}): Harness {
  const root = scratch();
  const launchesRoot = join(root, 'launches');
  const outputRoot = join(root, 'experiments');
  mkdirSync(launchesRoot, { recursive: true });
  mkdirSync(outputRoot, { recursive: true });
  const childPath = join(root, 'fake-child.mjs');
  const grandchildScript = join(root, 'fake-grandchild.mjs');
  writeFileSync(childPath, fakeChild);
  writeFileSync(grandchildScript, "await new Promise(r => setTimeout(r, 60000));\n");
  const childLog = join(root, 'child-launch.json');
  const grandchildLog = join(root, 'grandchild-pid.txt');
  const baseEnv: NodeJS.ProcessEnv = {
    BENCH_SUPERVISOR_TOKEN: '', BENCH_LAUNCH_RECORD: '', FAKE_CHILD_LOG: childLog,
    FAKE_SLEEP_MS: String(options.sleepMs ?? 300),
    ...(options.grandchild === true ? { FAKE_GRANDCHILD_LOG: grandchildLog, FAKE_GRANDCHILD_SCRIPT: grandchildScript } : {}),
  };
  const config = createConfigProvider({ root, env: { BENCH_DSH_PROVIDER: 'fake-provider', BENCH_DSH_MODEL: 'fake-model' } });
  const launches = launchesFor(config, { launchesRoot, childPath, baseEnv, options });
  return { root, launchesRoot, outputRoot, childPath, childLog, grandchildLog, grandchildScript, launches, baseEnv, config };
}

/** 同一个启动记录目录上的新实例：窗口二用它模拟「API 重启」。 */
function launchesFor(config: ReturnType<typeof createConfigProvider>, input: { launchesRoot: string; childPath: string; baseEnv: NodeJS.ProcessEnv; options?: HarnessOptions }) {
  return createLaunches({
    config, launchesRoot: input.launchesRoot, repositoryRoot, childScript: input.childPath, env: input.baseEnv,
    pollMs: 50, heartbeatMs: input.options?.heartbeatMs ?? 5_000, leaseTtlMs: input.options?.leaseTtlMs ?? 30_000,
    confirmMs: input.options?.confirmMs ?? 20_000, registrationWaitMs: input.options?.registrationWaitMs ?? 10_000,
  });
}

const launchRequest = (h: Harness, extra: Record<string, unknown> = {}) => ({
  scope: 'manual', taskIds: ['CACHE-02'], presets: ['standard'], modes: ['off'], repeats: 1,
  provider: 'fake-provider', model: 'fake-model', outputRoot: h.outputRoot, ...extra,
});

describe('续跑（--resume）经真实启动链路', () => {
  /** 假子进程记录收到的 argv，供断言续跑参数确实下发。 */
  const argvRecordingChild = `
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.FAKE_ARGV_LOG, JSON.stringify(process.argv.slice(2)));
await new Promise(r => setTimeout(r, Number(process.env.FAKE_SLEEP_MS ?? 300)));
`;

  it('续跑指向既有实验：下发 --resume 而非 --experiment-id，且实验目录不被新建', async () => {
    const h = harness();
    const existing = 'exp-existing-report';
    mkdirSync(join(h.outputRoot, existing), { recursive: true });
    // 续跑的 plan 取自报告 settings，所以夹具必须是含 settings 的报告（真实报告即如此）。
    writeFileSync(join(h.outputRoot, existing, 'experiment.json'), JSON.stringify({ schemaVersion: '0.3.0', rows: [],
      settings: { provider: 'fake-provider', model: 'fake-model', presets: ['standard'], modes: ['off'], repeats: 1, taskIds: ['CACHE-02'] } }));
    const argvLog = join(h.root, 'argv.json');
    const childPath = join(h.root, 'argv-child.mjs');
    writeFileSync(childPath, argvRecordingChild);
    const launches = createLaunches({ config: h.config, launchesRoot: h.launchesRoot, repositoryRoot, childScript: childPath,
      env: { ...h.baseEnv, FAKE_ARGV_LOG: argvLog }, pollMs: 50, confirmMs: 20_000, registrationWaitMs: 10_000 });
    const view = await launches.launch({ scope: 'manual', taskIds: ['CACHE-02'], presets: ['standard'], modes: ['off'], repeats: 1,
      provider: 'fake-provider', model: 'fake-model', outputRoot: h.outputRoot, resumeExperimentId: existing });
    // 实验标识是既有的那个；launchId 是新的（启动记录独立可审计）。
    expect(view.experimentId).toBe(existing);
    expect(view.launchId).not.toBe(existing);
    expect(view.args[0]).toBe('--resume');
    expect(view.args[1]).toBe(existing);
    expect(view.args).not.toContain('--experiment-id');
    // 既有报告必须原样保留，续跑不覆盖它。
    expect(existsSync(join(h.outputRoot, existing, 'experiment.json'))).toBe(true);
    await launches.cancel(view.launchId).catch(() => undefined);
  }, 30_000);

  it('续跑目标不存在或没有 experiment.json 时拒绝，且不创建任何目录', async () => {
    const h = harness();
    // 目标不存在。
    await expect(launchesFor(h.config, { launchesRoot: h.launchesRoot, childPath: h.childPath, baseEnv: h.baseEnv })
      .launch(launchRequest(h, { resumeExperimentId: 'no-such-experiment' }))).rejects.toThrow(/续跑目标不存在或没有 experiment.json/);
    // 目录存在但没有 experiment.json。
    mkdirSync(join(h.outputRoot, 'empty-dir'), { recursive: true });
    await expect(launchesFor(h.config, { launchesRoot: h.launchesRoot, childPath: h.childPath, baseEnv: h.baseEnv })
      .launch(launchRequest(h, { resumeExperimentId: 'empty-dir' }))).rejects.toThrow(/续跑目标不存在或没有 experiment.json/);
    // 续跑标识非法。
    await expect(launchesFor(h.config, { launchesRoot: h.launchesRoot, childPath: h.childPath, baseEnv: h.baseEnv })
      .launch(launchRequest(h, { resumeExperimentId: '../escape' }))).rejects.toThrow(/续跑标识不合法/);
    // 续跑不能与预检同时使用：预检不调用模型，续跑会。
    await expect(launchesFor(h.config, { launchesRoot: h.launchesRoot, childPath: h.childPath, baseEnv: h.baseEnv })
      .launch(launchRequest(h, { resumeExperimentId: 'x', check: true }))).rejects.toThrow(/续跑不能与预检同时使用/);
    // 以上全部拒绝：目录必须保持原样，不留下任何新建实验目录。
    expect(readdirSync(h.outputRoot).sort()).toEqual(['empty-dir']);
  }, 30_000);

  it('续跑只发实验标识即可：plan 取自报告里的 settings，不被界面缺省值拒绝', async () => {
    // 回归：报告中心的续跑按钮只发 { resumeExperimentId }（用户不该重选题目与等级）。
    // 若 plan 仍按界面缺省值构造（默认题目范围、配置里的预设与等级），
    // 与报告里的 55 题/ptc/high 必然不符，--resume 的配置核对会拒绝自己。
    const h = harness();
    const existing = 'exp-with-settings';
    mkdirSync(join(h.outputRoot, existing), { recursive: true });
    writeFileSync(join(h.outputRoot, existing, 'experiment.json'), JSON.stringify({
      schemaVersion: '0.3.0', rows: [],
      // 故意用与配置缺省值全都不同的参数，确保断言真的检验「取自报告」。
      settings: { provider: 'deepseek-official', model: 'deepseek-flash', presets: ['ptc'], modes: ['high'],
        repeats: 1, maxTokens: 64000, timeoutMs: 1_200_000, measurePerformance: false,
        taskIds: ['CACHE-02', 'CACHE-03', 'THR-01'] },
    }));
    const launches = launchesFor(h.config, { launchesRoot: h.launchesRoot, childPath: h.childPath, baseEnv: h.baseEnv });
    // 只发实验标识：不传 taskIds / presets / modes / maxTokens。
    const view = await launches.launch({ resumeExperimentId: existing, outputRoot: h.outputRoot });
    // plan 必须逐项等于报告里的 settings，而不是界面缺省值。
    expect(view.plan.taskIds).toEqual(['CACHE-02', 'CACHE-03', 'THR-01']);
    expect(view.plan.presets).toEqual(['ptc']);
    expect(view.plan.modes).toEqual(['high']);
    expect(view.plan.maxTokens).toBe(64000);
    expect(view.plan.provider).toBe('deepseek-official');
    expect(view.plan.model).toBe('deepseek-flash');
    expect(view.plan.answers).toBe(3);
    expect(view.args[0]).toBe('--resume');
    // 下发的 argv 也必须带上报告里的参数，否则子进程按自己的默认值跑，配置核对照样失败。
    expect(view.args.join(' ')).toContain('--tasks CACHE-02,CACHE-03,THR-01');
    expect(view.args.join(' ')).toContain('--presets ptc');
    expect(view.args.join(' ')).toContain('--modes high');
    expect(view.args.join(' ')).toContain('--max-tokens 64000');
    await launches.cancel(view.launchId).catch(() => undefined);
  }, 30_000);

  it('报告的 settings 无法解析时明确拒绝续跑，而不是静默按缺省值跑', async () => {
    const h = harness();
    const existing = 'exp-broken-settings';
    mkdirSync(join(h.outputRoot, existing), { recursive: true });
    writeFileSync(join(h.outputRoot, existing, 'experiment.json'), JSON.stringify({ schemaVersion: '0.3.0', rows: [], settings: { presets: ['ptc'] } }));
    await expect(launchesFor(h.config, { launchesRoot: h.launchesRoot, childPath: h.childPath, baseEnv: h.baseEnv })
      .launch({ resumeExperimentId: existing, outputRoot: h.outputRoot })).rejects.toThrow(/settings 无法解析/);
  }, 30_000);
  it('并行度大于 1 时下发 --concurrency；默认串行不下发', async () => {
    const h = harness();
    const launches = launchesFor(h.config, { launchesRoot: h.launchesRoot, childPath: h.childPath, baseEnv: h.baseEnv });
    // 默认 1：命令行保持原样，不产生无意义差异。
    const serial = await launches.launch(launchRequest(h));
    expect(serial.plan.concurrency).toBe(1);
    expect(serial.args).not.toContain('--concurrency');
    // 3 路：透传 plan 与命令行。
    const parallel = await launches.launch(launchRequest(h, { concurrency: 3 }));
    expect(parallel.plan.concurrency).toBe(3);
    const at = parallel.args.indexOf('--concurrency');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(parallel.args[at + 1]).toBe('3');
    // 越界被拒。
    await expect(launches.launch(launchRequest(h, { concurrency: 9 }))).rejects.toThrow(/并行度/);
    await expect(launches.launch(launchRequest(h, { concurrency: 0 }))).rejects.toThrow(/并行度/);
  }, 30_000);
  it('新建路径仍然用 --experiment-id，不受续跑改动影响', async () => {
    const h = harness();
    const view = await (launchesFor(h.config, { launchesRoot: h.launchesRoot, childPath: h.childPath, baseEnv: h.baseEnv }))
      .launch(launchRequest(h));
    expect(view.args[0]).toBe('--experiment-id');
    expect(view.args[1]).toBe(view.launchId);
    expect(view.args).not.toContain('--resume');
  }, 30_000);
});
describe('自动测评状态归并（mergeState 真值表）', () => {
  const exit = (code: number | null, signal: string | null = null, cancelled = false) =>
    ({ code, signal, at: '2026-09-14T00:00:00.000Z', descendantsVerified: true, note: null, cancelled });

  it('有 exit.json 且退出码 0 与 experiment completed → 已完成', () => {
    expect(mergeState('completed', 'running', exit(0), 'complete'))
      .toMatchObject({ process: 'exited', verdict: 'completed', exitOk: true, cleanup: 'complete', cleanupUncertain: false });
  });

  it('有 exit.json 且退出码非 0 → 失败（不因 experiment 仍 running 就说是未知）', () => {
    expect(mergeState('running', 'running', exit(2), 'pending')).toMatchObject({ process: 'exited', verdict: 'failed', exitOk: false });
  });

  it('退出码 0 但没有 experiment.json（仅预检）→ 已完成，且不谎报实验记录', () => {
    const merged = mergeState(null, 'registered', exit(0), null);
    expect(merged.verdict).toBe('completed');
    expect(merged.text).toContain('没有 experiment.json');
  });

  it('无 exit.json 且租约过期 → unknown，绝不写成启动失败', () => {
    const merged = mergeState(null, 'unknown', null, null);
    expect(merged).toMatchObject({ process: 'unknown', verdict: 'unknown', exitOk: null });
    expect(merged.text).toContain('执行状态未知，可能仍在运行');
    expect(JSON.stringify(merged)).not.toContain('launch-failed');
  });

  it('无 exit.json 但 supervisor 仍登记/运行 → 运行中', () => {
    expect(mergeState(null, 'registered', null, null)).toMatchObject({ verdict: 'running', process: 'live' });
    expect(mergeState('running', 'running', null, 'pending')).toMatchObject({ verdict: 'running', process: 'live' });
  });

  it('有 exit.json 且 cleanup 仍 pending → 清理未知，可能残留', () => {
    const merged = mergeState('completed', 'exited', exit(0), 'pending');
    expect(merged).toMatchObject({ cleanup: 'unknown', cleanupUncertain: true, verdict: 'completed' });
    expect(merged.cleanupText).toContain('可能残留');
  });

  it('completed 但归档里有未通过行、退出码 1 → completed-with-failures，不再判成失败', () => {
    // 真实复现形状：55 行全部跑完、48 行通过 / 7 行未通过；退出码 1 是 dsh-compare 的
    // CI 语义（有行未通过），不是进程异常退出。
    const merged = mergeState('completed', 'exited', exit(1), 'complete', { rows: 55, passed: 48, unpassed: 7 });
    expect(merged).toMatchObject({ process: 'exited', verdict: 'completed-with-failures', reportOutcome: 'completed-with-failures', exitOk: false, cleanup: 'complete' });
    expect(merged.text).toContain('7 行未通过（共 55 行）');
    expect(merged.text).toContain('不是进程异常退出');
  });

  it('completed 且逐行统计全部通过 → 已完成（归档的结论不被退出码改写）', () => {
    expect(mergeState('completed', 'exited', exit(0), 'complete', { rows: 55, passed: 55, unpassed: 0 }))
      .toMatchObject({ verdict: 'completed', reportOutcome: 'completed', exitOk: true });
    // 归档说「跑完且逐行全通过」就以它为准，但退出码与它不一致要如实并置，不静默吞掉。
    const conflicted = mergeState('completed', 'exited', exit(1), 'complete', { rows: 3, passed: 3, unpassed: 0 });
    expect(conflicted).toMatchObject({ verdict: 'completed', reportOutcome: 'completed', exitOk: false });
    expect(conflicted.text).toContain('与归档不一致');
  });

  it('completed 但没有逐行统计时，用非零退出码兜底识别「有未通过行」', () => {
    expect(mergeState('completed', 'exited', exit(1), 'complete'))
      .toMatchObject({ verdict: 'completed-with-failures', reportOutcome: 'completed-with-failures' });
    expect(mergeState('completed', 'exited', exit(0), 'complete')).toMatchObject({ verdict: 'completed', reportOutcome: 'completed' });
    // 有统计且 0 行未通过，不因缺统计才有的兜底而翻案。
    expect(mergeState('completed', 'exited', exit(0), 'complete', { rows: 0, passed: 0, unpassed: 0 }).verdict).toBe('completed');
  });

  it('state=failed 仍是失败；没有 experiment.json 时退出码语义不变', () => {
    expect(mergeState('failed', 'exited', exit(1), 'complete', { rows: 55, passed: 0, unpassed: 55 }))
      .toMatchObject({ verdict: 'failed', reportOutcome: 'failed', exitOk: false });
    expect(mergeState('failed', 'exited', exit(0), 'complete')).toMatchObject({ verdict: 'failed', reportOutcome: 'failed' });
    // 只有 exit.json（例如 --check 预检或报告未落盘）：维持「非零即失败」的原语义。
    expect(mergeState(null, 'exited', exit(1), 'pending')).toMatchObject({ verdict: 'failed', reportOutcome: null });
  });

  it('取消优先于 completed-with-failures，不被退出码抢走结论', () => {
    expect(mergeState(null, 'cancelled', exit(1, null, true), 'pending', { rows: 2, passed: 1, unpassed: 1 }))
      .toMatchObject({ verdict: 'cancelled', reportOutcome: null });
    expect(mergeState('cancelled', 'exited', exit(1), 'pending')).toMatchObject({ verdict: 'cancelled', reportOutcome: 'cancelled' });
  });

  it('没有 exit.json 时不拔高结论，但 reportOutcome 仍如实带出归档自己的结论', () => {
    const merged = mergeState('completed', 'unknown', null, 'complete', { rows: 2, passed: 1, unpassed: 1 });
    expect(merged).toMatchObject({ process: 'unknown', verdict: 'unknown', exitOk: null, reportOutcome: 'completed-with-failures' });
    expect(merged.text).toContain('执行状态未知');
  });

  it('只有 experiment.json 明写 complete/retained 才给出确定的清理结论', () => {
    expect(mergeState('completed', 'exited', exit(0), 'complete').cleanup).toBe('complete');
    expect(mergeState('failed', 'exited', exit(1), 'retained')).toMatchObject({ cleanup: 'retained', cleanupUncertain: false });
    expect(mergeState('failed', 'exited', exit(1), null)).toMatchObject({ cleanup: 'unknown', cleanupUncertain: true });
  });

  it('aborted（进程判定）与 cleanup（清理判定）永不合并', () => {
    const merged = mergeState('running', 'aborted', null, 'pending');
    expect(merged).toMatchObject({ process: 'aborted', verdict: 'aborted', cleanup: 'unknown', cleanupUncertain: true });
    expect(merged.text).toContain('不声称已确认终止');
  });

  it('取消 → 已取消，而不是失败（Windows taskkill /f 只给退出码 1、不带信号，靠显式取消事实）', () => {
    expect(mergeState(null, 'cancelled', exit(null, 'SIGKILL'), 'pending')).toMatchObject({ verdict: 'cancelled', process: 'cancelled' });
    expect(mergeState(null, 'cancelled', exit(null, 'cancel-requested'), 'pending')).toMatchObject({ verdict: 'cancelled' });
    expect(mergeState(null, 'cancelled', null, 'pending')).toMatchObject({ verdict: 'cancelled' });
    // 无信号的强制终止：只有显式 cancelled 标记才说得上是取消。
    expect(mergeState(null, 'cancelled', exit(1, null, true), 'pending')).toMatchObject({ verdict: 'cancelled' });
    expect(mergeState(null, 'running', exit(1, null, false), 'pending')).toMatchObject({ verdict: 'failed' });
  });
});

describe('启动记录显示实验自身的结论（读 experiment.json）', () => {
  const archive = (state: string, classifications: string[]) => ({
    schemaVersion: '0.3.0', id: 'exp', state, rows: classifications.map(classification => ({ evaluation: { status: { classification } } })),
    cleanup: { state: 'complete', directory: null, reason: null },
  });

  /** 启动一条记录，把退出事实改写成给定退出码，并写入归档；返回 describe() 的视图。 */
  async function settledWithArchive(h: Harness, code: number, report: Record<string, unknown>) {
    const view = await h.launches.launch(launchRequest(h));
    const exitPath = join(h.launchesRoot, view.launchId + '.exit.json');
    await until(() => { try { readFileSync(exitPath, 'utf8'); return true; } catch { return false; } }, 30_000, '退出事实');
    writeFileSync(exitPath, JSON.stringify({ ...(readJson(exitPath) ?? {}), code }));
    h.launches.sweep();
    const directory = join(h.outputRoot, view.launchId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'experiment.json'), JSON.stringify(report));
    return h.launches.describe(view.launchId);
  }

  it('归档 completed + 48 通过 / 7 未通过 + 退出码 1 → 已完成但有未通过行（真实复现形状）', async () => {
    const h = harness({ sleepMs: 300 });
    try {
      const described = await settledWithArchive(h, 1, archive('completed', [...Array(48).fill('passed'), ...Array(7).fill('check-failed')]));
      expect(described.state).toBe('exited');
      expect(described.exit?.code).toBe(1);
      expect(described.experiment.state).toBe('completed');
      expect(described.merged.verdict).toBe('completed-with-failures');
      expect(described.merged.reportOutcome).toBe('completed-with-failures');
      expect(described.merged.text).toContain('7 行未通过（共 55 行）');
    } finally { h.launches.close(); }
  }, 60_000);

  it('归档 state=failed → 仍然是失败（不把真失败说成「有未通过行」）', async () => {
    const h = harness({ sleepMs: 300 });
    try {
      const described = await settledWithArchive(h, 1, archive('failed', [...Array(53).fill('passed'), ...Array(2).fill('check-failed')]));
      expect(described.experiment.state).toBe('failed');
      expect(described.merged).toMatchObject({ verdict: 'failed', reportOutcome: 'failed' });
    } finally { h.launches.close(); }
  }, 60_000);
});

describe('受控启动（假脚本，不调用任何模型）', () => {
  it('计划总作答次数 = 题数 × 预设数 × 等级数 × 重复次数', () => {
    const h = harness();
    try {
      expect(h.launches.planOf(launchRequest(h, { presets: ['standard', 'ptc'], modes: ['off', 'high'], repeats: 3 })).answers).toBe(12);
      expect(h.launches.planOf(launchRequest(h)).answers).toBe(1);
      expect(h.launches.planOf(launchRequest(h, { scope: 'all' })).answers).toBe(55);
    } finally { h.launches.close(); }
  });

  it('拒绝无效参数（1–55 不重复题目、预设、重复次数）', () => {
    const h = harness();
    try {
      expect(() => h.launches.planOf(launchRequest(h, { taskIds: ['CACHE-02', 'CACHE-02'] }))).toThrow(LaunchError);
      expect(() => h.launches.planOf(launchRequest(h, { repeats: 0 }))).toThrow(LaunchError);
      expect(() => h.launches.planOf(launchRequest(h, { repeats: 21 }))).toThrow(LaunchError);
      expect(() => h.launches.planOf(launchRequest(h, { presets: ['nope'] }))).toThrow(LaunchError);
      expect(() => h.launches.planOf(launchRequest(h, { modes: [] }))).toThrow(LaunchError);
      expect(() => h.launches.planOf(launchRequest(h, { provider: '', model: 'fake-model' }))).toThrow(LaunchError);
    } finally { h.launches.close(); }
  });

  it('三阶段握手：supervisor 先登记，再让子进程通过授权屏障拿到同一令牌', async () => {
    const h = harness();
    try {
      const view = await h.launches.launch(launchRequest(h));
      expect(view.readable).toBe(true);
      // 阶段一/二：API 侧看到 supervisor 的登记与运行态，并记下 pid 与启动时间。
      expect(['registered', 'running']).toContain(view.state);
      expect(view.pid).not.toBeNull();
      expect(typeof view.pidStartedAt === 'string' || view.ownership === 'unconfirmed').toBe(true);
      // 阶段三：子进程读到的启动记录状态必须是 running，且令牌与记录一致。
      const observed = await until(() => readJson(h.childLog), 30_000, '子进程回执');
      const record = readJson(join(h.launchesRoot, view.launchId + '.json'));
      expect(observed.state).toBe('running');
      expect(observed.token).toBe(record?.supervisorToken);
      expect(typeof observed.heartbeatAt).toBe('string');
      // args 脱敏：命令行里只有开关与选择，没有任何令牌。
      expect(view.args).toContain('--experiment-id');
      expect(view.args.join(' ')).not.toContain(String(record?.supervisorToken));
      expect(JSON.stringify(view)).not.toContain(String(record?.supervisorToken));
    } finally { h.launches.close(); }
  }, 60_000);

  it('子进程正常退出后 sweeper 落定 exited（不是 aborted）并留下退出事实', async () => {
    const h = harness({ sleepMs: 400 });
    try {
      const view = await h.launches.launch(launchRequest(h));
      const exitPath = join(h.launchesRoot, view.launchId + '.exit.json');
      await until(() => { try { readFileSync(exitPath, 'utf8'); return true; } catch { return false; } }, 30_000, '退出事实');
      h.launches.sweep();
      const settled = h.launches.describe(view.launchId);
      expect(settled.state).toBe('exited');
      expect(settled.exit?.code).toBe(0);
      expect(settled.merged.verdict).toBe('completed');
      // 假脚本不写 experiment.json：清理事实只能是「未知，可能残留」。
      expect(settled.merged).toMatchObject({ cleanup: 'unknown', cleanupUncertain: true });
    } finally { h.launches.close(); }
  }, 60_000);

  it('--check 只预检：子进程收到 --check，退出码 0 且没有 experiment.json', async () => {
    const h = harness({ sleepMs: 300 });
    try {
      const view = await h.launches.launch(launchRequest(h, { check: true }));
      expect(view.kind).toBe('check');
      expect(view.args).toContain('--check');
      const observed = await until(() => readJson(h.childLog), 30_000, '子进程回执');
      expect(observed.argv).toContain('--check');
      const exitPath = join(h.launchesRoot, view.launchId + '.exit.json');
      await until(() => { try { readFileSync(exitPath, 'utf8'); return true; } catch { return false; } }, 30_000, '退出事实');
      h.launches.sweep();
      const settled = h.launches.describe(view.launchId);
      expect(settled.merged.verdict).toBe('completed');
      expect(settled.experiment.exists).toBe(false);
    } finally { h.launches.close(); }
  }, 60_000);
});

describe('四类故障窗口', () => {
  it('窗口一：supervisor 在 spawn 之前退出 → 子进程因授权屏障拒绝执行（断言没有失管执行）', async () => {
    const h = harness({ registrationWaitMs: 400 });
    const missingChild = join(h.root, 'missing-child.mjs');
    try {
      // 直连真实的 supervisor，观察拒绝执行：启动记录指定的子进程脚本不存在，supervisor 连登记都不做就拒绝。
      const directRecord = join(h.root, 'direct', 'supervisor.json');
      mkdirSync(join(h.root, 'direct'), { recursive: true });
      writeFileSync(directRecord, JSON.stringify({ launchId: 'direct', supervisorToken: 'direct-token', childScript: missingChild, childArgs: [],
        exitPath: join(h.root, 'direct', 'supervisor.exit.json'), cancelPath: join(h.root, 'direct', 'cancel'), logPath: null,
        leaseTtlMs: 30_000, heartbeatMs: 5_000, state: 'starting' }, null, 2) + '\n');
      const child = spawn(process.execPath, ['--import', 'tsx', supervisorScript, '--launch-record', directRecord], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      let stderr = '';
      child.stderr?.on('data', chunk => { stderr += String(chunk); });
      const code = await new Promise<number | null>(resolvePromise => child.on('exit', value => resolvePromise(value)));
      expect(code).not.toBe(0);
      expect(stderr).toContain('拒绝执行');
      // 没有任何子进程被启动，也没有退出事实被写出（拒绝路径不留假事实）。
      expect(readJson(join(h.root, 'direct', 'supervisor.exit.json'))).toBeNull();
      expect(readJson(directRecord)?.state).toBe('starting');

      // 同一条路径经 API：启动记录停在 starting（supervisor 未登记），sweeper 必须落定 aborted 并写明原因。
      const orphan = launchesFor(h.config, { launchesRoot: h.launchesRoot, childPath: missingChild, baseEnv: h.baseEnv, options: { registrationWaitMs: 400 } });
      try {
        const view = await orphan.launch(launchRequest(h));
        expect(view.state).toBe('starting');
        expect(view.pid).toBeNull();
        // 子进程根本没被启动：假脚本的回执文件不存在。
        expect(readJson(h.childLog)).toBeNull();
        orphan.sweep();
        const settled = orphan.describe(view.launchId);
        expect(settled.state).toBe('aborted');
        expect(settled.merged).toMatchObject({ verdict: 'aborted', process: 'aborted' });
        expect(String(settled.note)).toContain('没有执行任何作答');
      } finally { orphan.close(); }
    } finally { h.launches.close(); }
  }, 90_000);

  it('窗口二：API 重启后正常完成 → 新实例的 sweeper 读 exit.json 落定 exited（不是 aborted）', async () => {
    const h = harness({ sleepMs: 600 });
    try {
      const view = await h.launches.launch(launchRequest(h));
      const exitPath = join(h.launchesRoot, view.launchId + '.exit.json');
      await until(() => { try { readFileSync(exitPath, 'utf8'); return true; } catch { return false; } }, 30_000, '退出事实');
      // 模拟 API 重启：第一个实例关闭（不改动已落盘的记录），用全新实例对账。
      h.launches.close();
      const restarted = launchesFor(h.config, { launchesRoot: h.launchesRoot, childPath: h.childPath, baseEnv: h.baseEnv });
      try {
        restarted.sweep();
        const settled = restarted.describe(view.launchId);
        expect(settled.state).toBe('exited');
        expect(settled.merged.verdict).toBe('completed');
        expect(restarted.list().length).toBe(1);
      } finally { restarted.close(); }
    } finally { h.launches.close(); }
  }, 60_000);

  it('窗口三：父先退出而孙进程存活 → 取消后要么孙进程被回收，要么如实报「残留未知」', async () => {
    const h = harness({ grandchild: true, sleepMs: 15_000, confirmMs: 20_000 });
    let grandchildPid: number | null = null;
    try {
      const view = await h.launches.launch(launchRequest(h));
      const recordPath = join(h.launchesRoot, view.launchId + '.json');
      const childPid = await until(() => {
        const record = readJson(recordPath);
        return typeof record?.childPid === 'number' ? record.childPid : null;
      }, 30_000, '子进程 pid');
      grandchildPid = await until(() => { try { return Number(readFileSync(h.grandchildLog, 'utf8').trim()); } catch { return null; } }, 30_000, '孙进程 pid');
      expect(isAlive(childPid)).toBe(true);
      // 制造「父先退出」：直接杀掉 supervisor，子进程与孙进程继续存活。
      const supervisorPid = readJson(recordPath)?.pid;
      if (typeof supervisorPid === 'number') { try { process.kill(supervisorPid, 'SIGKILL'); } catch { /* 已退出 */ } }
      await until(() => !isAlive(typeof supervisorPid === 'number' ? supervisorPid : null), 15_000, 'supervisor 消失');
      expect(isAlive(childPid)).toBe(true);

      const outcome = await h.launches.cancel(view.launchId);
      expect(['terminated', 'terminated-unconfirmed', 'unknown', 'not-running']).toContain(outcome.action);
      if (outcome.action === 'terminated') {
        // 路径 A：声称已终止就必须真的回收了整棵树，包括孙进程。
        expect(outcome.targets).toContain(childPid);
        await until(() => !isAlive(childPid) && !isAlive(grandchildPid), 15_000, '整棵进程树退出');
        expect(outcome.residue.status).not.toBe('present');
      } else {
        // 路径 B：不允许假成功——必须如实说明没有确认终止，并且不声称无残留。
        expect(outcome.confirmedExit).toBe(false);
        expect(outcome.text).toContain('不声称已终止');
        expect(outcome.residue.status).not.toBe('none');
        expect(outcome.residue.detail.length).toBeGreaterThan(0);
      }
      // 两种路径下，归并视图都不会把「没有退出事实」写成失败或已完成：退出事实与清理事实各自独立。
      const described = h.launches.describe(view.launchId);
      expect(described.exit).toBeNull();
      expect(described.merged.exitOk).toBeNull();
      expect(described.merged.verdict).not.toBe('completed');
      expect(described.merged.verdict).not.toBe('failed');
      // 确认终止的路径必须把进程判定写实为 aborted；未确认的路径保持原状等 sweeper 如实落定 unknown。
      if (outcome.action === 'terminated') expect(described.state).toBe('aborted');
      else expect(['running', 'unknown', 'aborted', 'cancelled']).toContain(described.state);
    } finally {
      if (grandchildPid !== null && isAlive(grandchildPid)) { try { process.kill(grandchildPid, 'SIGKILL'); } catch { /* 已退出 */ } }
      h.launches.close();
    }
  }, 120_000);

  it('窗口四：GET /api/experiments 纯读 → 前后启动记录字节不变', async () => {
    // 假子进程活 20 秒、心跳 120 秒：GET 窗口内确定性地没有其它写者，字节不变的断言不靠运气。
    const h = harness({ heartbeatMs: 120_000, registrationWaitMs: 10_000, sleepMs: 20_000 });
    const app = buildApp(':memory:', {
      runToken: token, launchesRoot: h.launchesRoot, supervisorScript, childScript: h.childPath,
      supervisorPrefix: ['--import', 'tsx'], launchesHeartbeatMs: 120_000, launchesRegistrationWaitMs: 10_000,
      configRoot: h.root, configEnv: { BENCH_DSH_PROVIDER: 'fake-provider', BENCH_DSH_MODEL: 'fake-model' },
      // sweeper 也必须长于 GET 窗口：它与心跳一样是写者，落在两次 GET 之间就会破坏字节一致。
      launchesConfirmMs: 20_000, launchesSweepMs: 600_000,
    });
    try {
      const created = await app.inject({ method: 'POST', url: '/api/experiments', headers: { 'x-bench-token': token }, payload: launchRequest(h) });
      expect(created.statusCode).toBe(201);
      const bodyOfCreated = created.json() as { plannedAnswers: number; plan: { answers: number }; launch: LaunchView };
      expect(bodyOfCreated.plannedAnswers).toBe(1);
      const launchId = bodyOfCreated.launch.launchId;
      const path = join(h.launchesRoot, launchId + '.json');
      // 先等 supervisor 把子进程身份（childPid）写完，再取快照：否则量到的会是 supervisor 的写，而不是 GET 的副作用。
      await until(() => (readJson(path)?.childPid ?? null), 30_000, '子进程身份落盘');
      const before = readFileSync(path);
      const first = await app.inject('/api/experiments');
      expect(first.statusCode).toBe(200);
      const second = await app.inject('/api/experiments');
      expect(second.statusCode).toBe(200);
      expect(readFileSync(path).equals(before)).toBe(true);
      // 两次 GET 的响应字节也必须一致：GET 不产生任何副作用性的时间戳或计数。
      expect(second.body).toBe(first.body);
      const listed = (second.json() as { launches: LaunchView[] }).launches;
      const entry = listed.find(item => item.launchId === launchId);
      expect(entry?.merged.verdict).toBeDefined();
      expect(entry?.merged.cleanupText).toContain('可能残留');
      // GET 也不需要令牌（与 /api/config、/api/reports 的只读口径一致）。
      expect((await app.inject('/api/experiments')).statusCode).toBe(200);
    } finally { await app.close(); }
  }, 90_000);
});

describe('取消与残留口径', () => {
  it('supervisor 存活时由它代理取消，并轮询确认退出', async () => {
    const h = harness({ sleepMs: 30_000, confirmMs: 20_000 });
    try {
      const view = await h.launches.launch(launchRequest(h));
      const outcome = await h.launches.cancel(view.launchId);
      expect(['delegated', 'delegated-unconfirmed']).toContain(outcome.action);
      if (outcome.action === 'delegated') {
        expect(outcome.confirmedExit).toBe(true);
        expect(outcome.text).toContain('退出事实已落盘');
      } else {
        expect(outcome.confirmedExit).toBe(false);
        expect(outcome.text).toContain('不声称已终止');
      }
      const described = h.launches.describe(view.launchId);
      expect(described.cancelRequested).toBe(true);
      expect(['cancelled', 'unknown', 'aborted']).toContain(described.merged.verdict);
    } finally { h.launches.close(); }
  }, 120_000);

  it('supervisor 已死且没有可证明归属的存活进程时，不谎报「已确认无残留」', async () => {
    const h = harness({ sleepMs: 400 });
    try {
      const view = await h.launches.launch(launchRequest(h));
      const recordPath = join(h.launchesRoot, view.launchId + '.json');
      await until(() => { try { readFileSync(join(h.launchesRoot, view.launchId + '.exit.json'), 'utf8'); return true; } catch { return false; } }, 30_000, '退出事实');
      // 抹掉退出事实，制造「supervisor 已死 + 没有退出事实」：结论必须是 unknown，不能是「没有残留」。
      writeFileSync(join(h.launchesRoot, view.launchId + '.exit.json.tmp'), '{}');
      const described = h.launches.describe(view.launchId);
      expect(described.residue.status).not.toBe('none');
      expect(described.residue.status === 'none' ? '' : described.residue.detail).toContain('残留未知');
      expect(described.merged.cleanupUncertain).toBe(true);
      void recordPath;
    } finally { h.launches.close(); }
  }, 60_000);
});
describe('路由：发起、纯读、取消、外部提交', () => {
  function appHarness(extra: { submissionsRoot?: string } = {}) {
    const h = harness({ sleepMs: 30_000, heartbeatMs: 120_000 });
    const app = buildApp(':memory:', {
      runToken: token, launchesRoot: h.launchesRoot, supervisorScript, childScript: h.childPath,
      supervisorPrefix: ['--import', 'tsx'], launchesHeartbeatMs: 120_000, launchesRegistrationWaitMs: 10_000,
      // sweeper 调长：它对账会原子改写启动记录，若落在两次 GET 之间，会打断「响应字节一致」的断言。
      launchesConfirmMs: 20_000, launchesSweepMs: 600_000, configRoot: h.root,
      configEnv: { BENCH_DSH_PROVIDER: 'fake-provider', BENCH_DSH_MODEL: 'fake-model' },
      ...(extra.submissionsRoot === undefined ? {} : { submissionsRoot: extra.submissionsRoot }),
    });
    return { h, app };
  }

  it('POST /api/experiments 要求令牌，返回计划总作答次数，check 时传 --check', async () => {
    const { h, app } = appHarness();
    try {
      expect((await app.inject({ method: 'POST', url: '/api/experiments', payload: launchRequest(h) })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/api/experiments', headers: { 'x-bench-token': 'wrong' }, payload: launchRequest(h) })).statusCode).toBe(401);
      // 参数非法：1–55 不重复题目与预设规则由 @fsa/evaluation 的 validateComparison 判定。
      const invalid = await app.inject({ method: 'POST', url: '/api/experiments', headers: { 'x-bench-token': token }, payload: launchRequest(h, { presets: ['nope'] }) });
      expect(invalid.statusCode).toBe(400);
      expect(String(invalid.json().error)).toContain('预设');

      const check = await app.inject({ method: 'POST', url: '/api/experiments', headers: { 'x-bench-token': token },
        payload: launchRequest(h, { check: true, presets: ['standard', 'ptc'], modes: ['off', 'high'], repeats: 2 }) });
      expect(check.statusCode).toBe(201);
      const body = check.json() as { plannedAnswers: number; launch: LaunchView };
      expect(body.plannedAnswers).toBe(8);
      expect(body.launch.kind).toBe('check');
      expect(body.launch.args).toContain('--check');
      // 先等 supervisor 的自登记落盘：它本身就是一个写者，
      // 若恰好落在两次 GET 之间，会把「GET 无副作用」的字节比较变成竞态（与窗口四同一处理）。
      const path = join(h.launchesRoot, body.launch.launchId + '.json');
      await until(() => (readJson(path)?.childPid ?? null), 30_000, '子进程身份落盘');
      // 一次真实发起的写入只有一次：GET 不会因多次读取而改变响应。
      const first = (await app.inject('/api/experiments')).json() as { launches: LaunchView[] };
      const second = (await app.inject('/api/experiments')).json() as { launches: LaunchView[] };
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    } finally { await app.close(); h.launches.close(); }
  }, 90_000);

  it('POST /api/experiments/:launchId/cancel 要求令牌，并按 supervisor 存活与否如实报告', async () => {
    const { h, app } = appHarness();
    try {
      const created = await app.inject({ method: 'POST', url: '/api/experiments', headers: { 'x-bench-token': token }, payload: launchRequest(h) });
      const launchId = (created.json() as { launch: LaunchView }).launch.launchId;
      expect((await app.inject({ method: 'POST', url: '/api/experiments/' + launchId + '/cancel' })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/api/experiments/unknown-id/cancel', headers: { 'x-bench-token': token } })).statusCode).toBe(404);
      const cancelled = await app.inject({ method: 'POST', url: '/api/experiments/' + launchId + '/cancel', headers: { 'x-bench-token': token } });
      expect(cancelled.statusCode).toBe(200);
      const outcome = cancelled.json() as { action: string; confirmedExit: boolean; residue: { status: string; detail: string } };
      expect(['delegated', 'delegated-unconfirmed']).toContain(outcome.action);
      // 残留三态：给 none 必须有证据——写明是 supervisor 的终止后核对，而不是「扫不到就当干净」。
      expect(['none', 'unknown', 'present']).toContain(outcome.residue.status);
      if (outcome.residue.status === 'none') expect(outcome.residue.detail).toContain('supervisor');
    } finally { await app.close(); h.launches.close(); }
  }, 120_000);

  it('取消路由容忍「带 JSON content-type 却无请求体」：不再被 400 挡在业务逻辑之前', async () => {
    const { h, app } = appHarness();
    try {
      const created = await app.inject({ method: 'POST', url: '/api/experiments', headers: { 'x-bench-token': token }, payload: launchRequest(h) });
      const launchId = (created.json() as { launch: LaunchView }).launch.launchId;
      const cancelUrl = '/api/experiments/' + launchId + '/cancel';
      // 容忍空体只影响解析器，不放松授权：无令牌仍然先被拒。
      expect((await app.inject({ method: 'POST', url: cancelUrl, headers: { 'content-type': 'application/json' } })).statusCode).toBe(401);
      // 回归形状：网页「取消这次测评」曾经发出「带 application/json 且没有请求体」的请求，
      // Fastify 以 400 FST_ERR_CTP_EMPTY_JSON_BODY 拒绝，请求根本到不了 launches.cancel()。
      const emptyJson = await app.inject({ method: 'POST', url: cancelUrl, headers: { 'x-bench-token': token, 'content-type': 'application/json' } });
      expect(emptyJson.statusCode).toBe(200);
      const outcome = emptyJson.json() as { launchId: string; action: string };
      // 走的是真实的取消分支（结果取决于此刻 supervisor 是否还活着），但请求确实到达了业务逻辑：
      // 取消标记与账本字段都已落盘，而不是被解析器挡回。
      expect(outcome.launchId).toBe(launchId);
      expect(typeof outcome.action).toBe('string');
      expect(readJson(join(h.launchesRoot, launchId + '.json'))?.cancelRequestedAt).toBeTruthy();
      expect(existsSync(join(h.launchesRoot, launchId + '.cancel-requested'))).toBe(true);
      // 容忍的边界只到「真的没有请求体」：带畸形 JSON 的请求照旧 400，参数校验没有被放宽。
      const malformed = await app.inject({ method: 'POST', url: cancelUrl, headers: { 'x-bench-token': token, 'content-type': 'application/json' }, payload: '{oops' });
      expect(malformed.statusCode).toBe(400);
      expect(JSON.parse(malformed.body).code).toBe('FST_ERR_CTP_INVALID_JSON_BODY');
    } finally { await app.close(); h.launches.close(); }
  }, 120_000);

  it('GET /api/submissions 有界列出候选；POST 校验候选必须在提交根内（realpath 防逃逸）', async () => {
    const h = harness();
    const submissions = join(h.root, 'submissions');
    mkdirSync(join(submissions, 'candidate-one'), { recursive: true });
    mkdirSync(join(submissions, 'candidate-two'), { recursive: true });
    const outside = join(h.root, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(submissions, 'a-file.txt'), 'not-a-directory');
    try {
      const { app } = appHarness({ submissionsRoot: submissions });
      try {
        const listed = (await app.inject('/api/submissions')).json() as { root: string; candidates: Array<{ name: string }>; truncated: boolean };
        expect(listed.candidates.map(item => item.name).sort()).toEqual(['candidate-one', 'candidate-two']);
        expect(listed.truncated).toBe(false);

        expect((await app.inject({ method: 'POST', url: '/api/submissions', payload: { taskId: 'CACHE-02' } })).statusCode).toBe(401);
        const base = { taskId: 'CACHE-02', idempotencyKey: 'launch-test-key-1', reason: 'agent-completed' };
        // 越界与不存在都必须拒绝。
        expect((await app.inject({ method: 'POST', url: '/api/submissions', headers: { 'x-bench-token': token }, payload: { ...base, candidateDirectory: '../outside' } })).statusCode).toBe(400);
        expect((await app.inject({ method: 'POST', url: '/api/submissions', headers: { 'x-bench-token': token }, payload: { ...base, candidateDirectory: 'missing' } })).statusCode).toBe(400);
        // 协议不完整的提交给 400，而不是让冻结链路去猜。
        expect((await app.inject({ method: 'POST', url: '/api/submissions', headers: { 'x-bench-token': token }, payload: { taskId: 'CACHE-02' } })).statusCode).toBe(400);
        expect((await app.inject({ method: 'POST', url: '/api/submissions', headers: { 'x-bench-token': token }, payload: { ...base, idempotencyKey: 'short' } })).statusCode).toBe(400);
      } finally { await app.close(); }
    } finally { h.launches.close(); }
  }, 60_000);
});

describe('dsh-compare 的 --experiment-id 与授权屏障（不调用任何模型）', () => {
  const runCompare = (args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string; stdout: string }> => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(repositoryRoot, 'scripts', 'dsh-compare.ts'), ...args],
      { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '', stdout = '';
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    return new Promise(resolvePromise => child.on('exit', code => resolvePromise({ code, stderr, stdout })));
  };

  it('--experiment-id 非法即拒绝，且不创建任何目录', async () => {
    const root = scratch();
    const output = join(root, 'experiments');
    const result = await runCompare(['--check', '--experiment-id', '../escape', '--output', output], {});
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('实验标识不合法');
    expect(existsSync(join(root, 'escape'))).toBe(false);
  }, 60_000);

  it('--experiment-id 已存在即拒绝覆盖，绝不改动已有实验', async () => {
    const root = scratch();
    const output = join(root, 'experiments');
    mkdirSync(join(output, 'exp-claimed'), { recursive: true });
    const result = await runCompare(['--check', '--experiment-id', 'exp-claimed', '--output', output], {});
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('实验目录已存在，拒绝覆盖');
    expect(readdirSync(join(output, 'exp-claimed'))).toEqual([]);
  }, 60_000);

  it('授权屏障：令牌不匹配或缺少启动记录时在作答前拒绝执行', async () => {
    const root = scratch();
    const recordPath = join(root, 'record.json');
    const output = join(root, 'experiments');
    // 令牌与记录不一致。
    writeFileSync(recordPath, JSON.stringify({ supervisorToken: 'the-real-token', state: 'running', heartbeatAt: new Date().toISOString(), leaseTtlMs: 30_000 }, null, 2) + '\n');
    const mismatch = await runCompare(['--check'], { BENCH_SUPERVISOR_TOKEN: 'a-different-token', BENCH_LAUNCH_RECORD: recordPath, BENCH_DSH_REPORT_DIR: output });
    expect(mismatch.code).not.toBe(0);
    expect(mismatch.stderr).toContain('令牌不匹配');
    // 有令牌但没有启动记录。
    const noRecord = await runCompare(['--check'], { BENCH_SUPERVISOR_TOKEN: 'the-real-token', BENCH_LAUNCH_RECORD: '' });
    expect(noRecord.code).not.toBe(0);
    expect(noRecord.stderr).toContain('缺少启动记录');
    // 租约过期。
    writeFileSync(recordPath, JSON.stringify({ supervisorToken: 'the-real-token', state: 'running', heartbeatAt: new Date(Date.now() - 600_000).toISOString(), leaseTtlMs: 30_000 }, null, 2) + '\n');
    const expired = await runCompare(['--check'], { BENCH_SUPERVISOR_TOKEN: 'the-real-token', BENCH_LAUNCH_RECORD: recordPath });
    expect(expired.code).not.toBe(0);
    expect(expired.stderr).toContain('租约已过期');
    // 三次拒绝都不创建实验目录。
    expect(existsSync(output)).toBe(false);
  }, 90_000);
});
describe('与真实 dsh-compare 的受控接线（--check，不调用模型、不启动 DSH 会话）', () => {
  it('真实子进程通过授权屏障后才执行预检；--experiment-id 生效且不创建实验目录', async () => {
    const root = scratch();
    const launchesRoot = join(root, 'launches');
    const outputRoot = join(root, 'experiments');
    mkdirSync(launchesRoot, { recursive: true });
    const config = createConfigProvider({ root, env: { BENCH_DSH_PROVIDER: 'fake-provider', BENCH_DSH_MODEL: 'fake-model' } });
    // childScript 指向真实的 scripts/dsh-compare.ts：supervisor 会用 node --import tsx 启动它。
    const launches = createLaunches({ config, launchesRoot, repositoryRoot, env: {}, pollMs: 50, registrationWaitMs: 10_000, confirmMs: 20_000 });
    try {
      const view = await launches.launch({
        scope: 'manual', taskIds: ['CACHE-02'], presets: ['standard'], modes: ['off'], repeats: 1,
        provider: 'fake-provider', model: 'fake-model', outputRoot, check: true,
      });
      // 默认 childScript 就是仓库里的真实 scripts/dsh-compare.ts。
      expect(String(readJson(join(launchesRoot, view.launchId + '.json'))?.childScript).endsWith('dsh-compare.ts')).toBe(true);
      const exitPath = join(launchesRoot, view.launchId + '.exit.json');
      await until(() => { try { readFileSync(exitPath, 'utf8'); return true; } catch { return false; } }, 60_000, '退出事实');
      launches.sweep();
      const settled = launches.describe(view.launchId);
      // 关键断言：子进程确实活着跑过（有退出事实），而不是被授权屏障拒绝。
      expect(settled.exit).not.toBeNull();
      const log = readFileSync(settled.logPath, 'utf8');
      expect(log).toContain('supervisor 已登记');
      expect(log).toContain('子进程已启动');
      expect(log).not.toContain('拒绝执行');
      // 预检不创建实验目录（认领目录只发生在真实作答路径上）；本地 DSH/镜像不满足时退出码非 0，但那是预检结论。
      expect(existsSync(join(outputRoot, view.experimentId))).toBe(false);
      expect(settled.experiment.exists).toBe(false);
    } finally { launches.close(); }
  }, 120_000);
});

describe('归档启动记录（clean）的闸门只拦「真的还在跑」', () => {
  /** 捕获 LaunchError 以便断言状态码；不是 LaunchError 一律算未抛。 */
  const attempt = (fn: () => unknown): LaunchError | null => {
    try { fn(); return null; } catch (error) { return error instanceof LaunchError ? error : null; }
  };

  /**
   * 纯夹具：直接写启动记录，不经过 launch()，因此没有真实 supervisor。
   * childScript 指向仓库内真实脚本（reconcile 只改写这种记录），心跳、pid 与后代由各用例安排，
   * 用来精确制造目标进程判定。写出的字段与 LaunchRecord 同形，缺省值可被 record 覆盖。
   */
  function fixture(h: Harness, launchId: string, record: Record<string, unknown>): void {
    writeFileSync(join(h.launchesRoot, launchId + '.json'), JSON.stringify({
      launchId, supervisorToken: 'fixture-token', kind: 'comparison', experimentId: launchId, outputRoot: h.outputRoot,
      startedAt: '2026-09-26T17:22:46.133Z', state: 'unknown', exitCode: null, logPath: join(h.launchesRoot, launchId + '.log'),
      plan: { taskIds: ['CACHE-02'], presets: ['standard'], modes: ['off'], repeats: 1, timeoutMinutes: 20, maxTokens: 16384,
        measurePerformance: false, provider: 'fake-provider', model: 'fake-model', answers: 1, concurrency: 1 },
      args: [], childScript: supervisorScript, childArgs: [], exitPath: join(h.launchesRoot, launchId + '.exit.json'),
      cancelPath: join(h.launchesRoot, launchId + '.cancel-requested'), pid: null, pidStartedAt: null,
      childPid: null, childStartedAt: null, heartbeatAt: null,
      leaseTtlMs: 30_000, heartbeatMs: 5_000, descendants: [], cancelRequestedAt: null, settledAt: null, note: null,
      ...record,
    }) + '\n');
    writeFileSync(join(h.launchesRoot, launchId + '.log'), 'fixture log\n');
  }

  it('unknown 且没有可证明归属的存活进程 → clean 成功，且列表不再显示', () => {
    const h = harness();
    try {
      // 强杀场景的复现：supervisor 与子进程的 pid 都早已不存在（没有退出事实），后代无法核对。
      fixture(h, 'exp-killed-supervisor', {
        state: 'unknown', pid: 62140, pidStartedAt: '2026-09-26T17:22:40.000Z',
        childPid: 62141, childStartedAt: '2026-09-26T17:22:41.000Z', heartbeatAt: '2026-09-26T17:22:46.133Z',
        note: 'supervisor 租约已过期且没有退出事实：执行状态未知，可能仍在运行。',
      });
      const before = h.launches.describe('exp-killed-supervisor');
      expect(before.state).toBe('unknown');
      expect(before.merged.verdict).toBe('unknown');
      // 闸门的第二条证据必须不成立，否则这条用例测的就不是「放开 unknown」。
      expect(before.residue.status).not.toBe('present');
      const outcome = h.launches.clean('exp-killed-supervisor');
      expect(outcome.moved).toContain('exp-killed-supervisor.json');
      expect(outcome.moved).toContain('exp-killed-supervisor.log');
      expect(h.launches.list().some(item => item.launchId === 'exp-killed-supervisor')).toBe(false);
      // 移动而不是删除：账本原样躺在回收目录里，可手动移回。
      expect(readFileSync(join(outcome.trashPath, 'exp-killed-supervisor.json'), 'utf8')).toContain('exp-killed-supervisor');
    } finally { h.launches.close(); }
  }, 30_000);

  it('进程判定仍在运行（starting/registered/running）→ 409，账本原样不动', () => {
    const h = harness();
    try {
      for (const state of ['starting', 'registered', 'running'] as const) {
        fixture(h, 'exp-' + state, { state, pid: 62150, heartbeatAt: new Date().toISOString() });
        const error = attempt(() => h.launches.clean('exp-' + state));
        expect(error?.status).toBe(409);
        expect(String(error?.message)).toContain('仍在运行');
        expect(existsSync(join(h.launchesRoot, 'exp-' + state + '.json'))).toBe(true);
      }
    } finally { h.launches.close(); }
  }, 30_000);

  it('残留扫描报 present（有可证明归属的存活子进程）→ 409，文案指明是可证明归属的存活进程', () => {
    const h = harness();
    let sleeper: number | null = null;
    try {
      sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true }).pid ?? null;
      expect(sleeper).not.toBeNull();
      const startedAt = processStartTime(sleeper as number, { cache: false });
      // 归属可证需要进程启动时间；本平台取不到时前提不成立，如实跳过而不是伪造结论。
      if (startedAt === null) return;
      fixture(h, 'exp-live-child', {
        state: 'unknown', pid: 62160, pidStartedAt: '2026-09-26T17:22:40.000Z', heartbeatAt: '2026-09-26T17:22:46.133Z',
        childPid: sleeper, childStartedAt: startedAt,
      });
      expect(h.launches.describe('exp-live-child').residue.status).toBe('present');
      const error = attempt(() => h.launches.clean('exp-live-child'));
      expect(error?.status).toBe(409);
      expect(String(error?.message)).toContain('可证明归属的存活进程');
      expect(existsSync(join(h.launchesRoot, 'exp-live-child.json'))).toBe(true);
    } finally {
      if (sleeper !== null && isAlive(sleeper)) { try { process.kill(sleeper, 'SIGKILL'); } catch { /* 已退出 */ } }
      h.launches.close();
    }
  }, 30_000);
});
/** 与 T2 的 clean 闸门共用同一个夹具形状：直接写启动记录，不经过 launch()。 */
function residueFixture(h: Harness, launchId: string, record: Record<string, unknown>): void {
  writeFileSync(join(h.launchesRoot, launchId + '.json'), JSON.stringify({
    launchId, supervisorToken: 'fixture-token', kind: 'comparison', experimentId: launchId, outputRoot: h.outputRoot,
    startedAt: '2026-09-27T03:14:26.894Z', state: 'unknown', exitCode: null, logPath: join(h.launchesRoot, launchId + '.log'),
    plan: { taskIds: ['CACHE-02'], presets: ['standard'], modes: ['off'], repeats: 1, timeoutMinutes: 20, maxTokens: 16384,
      measurePerformance: false, provider: 'fake-provider', model: 'fake-model', answers: 1, concurrency: 1 },
    args: [], childScript: supervisorScript, childArgs: [], exitPath: join(h.launchesRoot, launchId + '.exit.json'),
    cancelPath: join(h.launchesRoot, launchId + '.cancel-requested'), pid: null, pidStartedAt: null,
    childPid: null, childStartedAt: null, heartbeatAt: null,
    leaseTtlMs: 30_000, heartbeatMs: 5_000, descendants: [], cancelRequestedAt: null, settledAt: null, note: null,
    ...record,
  }) + '\n');
  writeFileSync(join(h.launchesRoot, launchId + '.log'), 'fixture log\n');
}

/** 退出事实文件：descendantsVerified 是 supervisor 的终止后核对结论。 */
function writeExitFixture(h: Harness, launchId: string, descendantsVerified: boolean): void {
  writeFileSync(join(h.launchesRoot, launchId + '.exit.json'), JSON.stringify({
    code: 0, signal: null, at: '2026-09-27T04:30:00.000Z', descendantsVerified, note: null, cancelled: false,
  }, null, 2) + '\n');
}

describe('残留口径：运行中不报警、落定以 supervisor 的后代核对为准', () => {
  it('运行中（子进程树仍在场）不以「仍有残留」告警，只给中性描述', () => {
    const h = harness();
    let sleeper: number | null = null;
    try {
      sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true }).pid ?? null;
      expect(sleeper).not.toBeNull();
      const startedAt = processStartTime(sleeper as number, { cache: false });
      // 归属可证需要进程启动时间；本平台取不到时前提不成立，如实跳过而不是伪造结论。
      if (startedAt === null) return;
      // 现象 A 的复现形状：正在跑的实验，子进程树里的进程被旧口径当成「残留」。
      residueFixture(h, 'exp-running', {
        state: 'running', pid: process.pid, pidStartedAt: processStartTime(process.pid, { cache: false }),
        heartbeatAt: new Date().toISOString(), childPid: sleeper, childStartedAt: startedAt,
      });
      const view = h.launches.describe('exp-running');
      expect(view.residue.status).not.toBe('present');
      expect(view.residue.detail).toContain('运行中');
      expect(view.residue.detail).not.toContain('仍有残留');
      // 中性描述仍如实报出在场进程的数量与 pid，不隐藏事实。
      expect(view.residue.pids).toContain(sleeper);
      expect(view.residue.detail).toMatch(/子进程树 \d+ 个存活进程/);
    } finally {
      if (sleeper !== null && isAlive(sleeper)) { try { process.kill(sleeper, 'SIGKILL'); } catch { /* 已退出 */ } }
      h.launches.close();
    }
  }, 30_000);

  it('已落定且 exit.json 核对 descendantsVerified=true → none，文案写明依据是 supervisor 的终止后核对', () => {
    const h = harness();
    try {
      // 现象 B 的复现形状：进程都已退出，退出事实已确认整棵后代树退出。
      residueFixture(h, 'exp-settled-clean', {
        state: 'exited', pid: 62170, pidStartedAt: '2026-09-26T15:40:30.000Z',
        childPid: 62171, childStartedAt: '2026-09-26T15:40:34.000Z', heartbeatAt: '2026-09-26T15:41:00.000Z',
      });
      writeExitFixture(h, 'exp-settled-clean', true);
      const view = h.launches.describe('exp-settled-clean');
      expect(view.exit?.descendantsVerified).toBe(true);
      expect(view.residue.status).toBe('none');
      expect(view.residue.detail).toContain('supervisor');
      expect(view.residue.detail).toContain('后代');
      expect(view.residue.pids).toEqual([]);
    } finally { h.launches.close(); }
  }, 30_000);

  it('没有退出事实、归属不可证 → unknown（绝不因为「扫不到」就说干净）', () => {
    const h = harness();
    try {
      // 强杀场景：supervisor 与子进程的 pid 都早已不存在，后代核对无从谈起。
      residueFixture(h, 'exp-unknown', {
        state: 'unknown', pid: 62180, pidStartedAt: '2026-09-26T17:22:40.000Z',
        childPid: 62181, childStartedAt: '2026-09-26T17:22:41.000Z', heartbeatAt: '2026-09-26T17:22:46.133Z',
        note: 'supervisor 租约已过期且没有退出事实：执行状态未知，可能仍在运行。',
      });
      const view = h.launches.describe('exp-unknown');
      expect(view.residue.status).toBe('unknown');
      expect(view.residue.detail).toContain('残留未知');
      expect(view.residue.detail).not.toContain('已确认无残留');
    } finally { h.launches.close(); }
  }, 30_000);
});

