import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkDshInstallation, DshCleanupError, resolveDshPreset, runDsh, type DshHarness, type DshRunOptions } from './dsh.ts';

let temporaryRoot: string;
let options: DshRunOptions;

beforeEach(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), 'fsa-dsh-adapter-'));
  const dshRoot = join(temporaryRoot, 'dsh');
  for (const [path, content] of [
    ['packages/sdk/client/package.json', JSON.stringify({ name: '@deepseek-ai/dsh-sdk-client', version: '0.1.5' })],
    ['apps/cli/package.json', JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5' })],
    ['packages/sdk/client/lib/index.js', 'throw new Error("fake must use injected SDK")'],
    ['apps/cli/lib/bin.js', 'throw new Error("fake CLI must not start")'],
    ['packages/core/scope/lib/index.js', 'export const createScope = () => {};'],
    ['packages/preset/agent-presets/lib/index.js', 'export default {};'],
    ['packages/bundle/web-app/cordis.patch.yml', '# ── the agent plane moves behind agent presets\n- id: tool-bash\n  disabled: true\n- id: tool-fs\n  disabled: true\n# The preset roster.'],
    ...['standard', 'ptc', 'minimal', 'cordis'].map(id => [`packages/preset/agent-presets/presets/${id}/agent.cordis.yml`, `# ${id}\n- id: persona\n`]),
  ]) {
    const target = join(dshRoot, path!);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content!);
  }
  const workspace = join(temporaryRoot, 'candidate');
  mkdirSync(workspace);
  options = {
    dshRoot, dshHome: join(temporaryRoot, 'home'), workspace,
    provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high',
    maxTokens: 4096, timeoutMs: 1000, sessionId: 'test-session', prompt: 'Read TASK.md and solve it.',
    scratchDirectory: join(temporaryRoot, 'runtime'),
  };
});

afterEach(() => { rmSync(temporaryRoot, { recursive: true, force: true }); });

function result(reason?: string) {
  return {
    finalResponse: 'done',
    events: [
      { type: 'agent-preset/selected', data: { agentPreset: 'standard' } },
      { type: 'assistant/message', data: { message: { source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }, usage: { inputTokens: 2, outputTokens: 3 } } },
      ...reason === undefined ? [] : [{ type: 'turn/end', data: { reason: { kind: reason } } }],
    ],
  };
}

describe('DSH automation adapter', () => {
  it('isolates solver environment and workspace while retaining only evidenced model fields', async () => {
    const env = { PATH: 'runtime-path', DEEPSEEK_API_KEY: 'solver-secret', BENCH_JUDGE_TOKEN: 'judge-secret', bench_run_token: 'control-secret', NODE_OPTIONS: '--env-file=private', Node_Path: 'private', DSH_HOME: 'inherited-home' };
    const close = vi.fn(async () => {});
    const createHarness = vi.fn((launch) => {
      expect(launch.processCwd).toBe(options.workspace);
      expect(launch.cwd).toBe(options.workspace);
      expect(launch.env).toEqual({ PATH: 'runtime-path', DEEPSEEK_API_KEY: 'solver-secret', DSH_HOME: options.dshHome, DSH_TELEMETRY_DISABLED: '1' });
      expect(launch.dshBin).toBe(join(options.dshRoot, 'apps/cli/lib/bin.js'));
      return { run: vi.fn(async () => result('completed')), close };
    });
    const report = await runDsh({ ...options, env }, { createHarness });
    expect(report).toMatchObject({ finishReason: 'completed', runtimeClosed: true, cleanupScope: 'sdk-runtime', dshVersion: '0.1.5', usage: null, responseModels: [] });
    expect(report.requestedModel.reasoningEffort).toBe('high');
    expect(report.observedRoutes).toEqual([{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }]);
    expect(report.observedPresets).toEqual(['standard']);
    expect(close).toHaveBeenCalledOnce();
    expect(env.BENCH_JUDGE_TOKEN).toBe('judge-secret');
  });

  it.each(['max-tokens', 'error', undefined])('does not turn idle with %s into completed', async reason => {
    const report = await runDsh(options, { createHarness: () => ({ run: async () => result(reason), close: async () => {} }) });
    expect(report.finishReason).toBe(reason ?? 'missing-turn-end');
  });

  it('waits for owned runtime cleanup before returning timeout and ignores late completion', async () => {
    let releaseClose!: () => void;
    let finishRun!: (value: ReturnType<typeof result>) => void;
    const closing = new Promise<void>(resolve => { releaseClose = resolve; });
    const close = vi.fn(() => closing);
    let returned = false;
    const pending = runDsh({ ...options, timeoutMs: 10 }, {
      createHarness: () => ({ run: () => new Promise(resolve => { finishRun = resolve; }), close }),
    }).then(report => { returned = true; return report; });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(returned).toBe(false);
    finishRun(result('completed'));
    releaseClose();
    expect((await pending).finishReason).toBe('timeout');
  });

  it('cancels an active run and refuses pre-cancelled work without creating a runtime', async () => {
    const controller = new AbortController();
    let rejectWork!: (error: Error) => void;
    const close = vi.fn(async () => { rejectWork(new Error('transport closed')); });
    const createHarness = vi.fn((): DshHarness => ({
      run: () => new Promise((_resolve, reject) => { rejectWork = reject; controller.abort(); }), close,
    }));
    const report = await runDsh({ ...options, signal: controller.signal }, { createHarness });
    expect(report.finishReason).toBe('cancelled');
    expect(close).toHaveBeenCalledOnce();
    await expect(runDsh({ ...options, signal: controller.signal }, { createHarness })).rejects.toThrow();
    expect(createHarness).toHaveBeenCalledOnce();
  });

  it('propagates failed cleanup instead of reporting successful cancellation', async () => {
    await expect(runDsh(options, { createHarness: () => ({
      run: async () => result('completed'), close: async () => { throw new Error('runtime is still alive'); },
    }) })).rejects.toBeInstanceOf(DshCleanupError);
    expect(existsSync(options.scratchDirectory!)).toBe(true);
  });

  it('loads the requested preset through a launch overlay and redirects run artifacts without changing the source home', async () => {
    const report = await runDsh({ ...options, agentPreset: resolveDshPreset('创造模式') }, { createHarness: launch => {
      const patch = JSON.parse(readFileSync(launch.patches[0]!, 'utf8')) as Record<string, unknown>[];
      expect(patch).toContainEqual({ id: 'tool-fs', disabled: true });
      expect(patch).toContainEqual({ id: 'session-persistence-jsonl', config: { root: join(options.scratchDirectory!, 'sessions') } });
      expect(patch).toContainEqual({ id: 'storage-json', config: { root: join(options.scratchDirectory!, 'storages') } });
      const text = readFileSync(join(options.scratchDirectory!, 'preset-bridge.mjs'), 'utf8');
      expect(text).toContain('await ctx.agentPresets.mount(parent.ctx, "cordis")');
      expect(text).toContain("ctx.agentPresets.composeFrom(agent.ctx, parent.ctx)");
      expect(launch.dshHome).toBe(options.dshHome);
      return { close: async () => {}, run: async () => ({ ...result('completed'), events: [
        { type: 'agent-preset/selected', data: { agentPreset: 'cordis' } }, ...result('completed').events.slice(1),
      ] }) };
    } });
    expect(report.requestedPreset).toBe('cordis');
    expect(report.observedPresets).toEqual(['cordis']);
    expect(report.presetFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([[], ['ptc'], ['standard', 'ptc']].map(presets => ({ presets })))('refuses completion with absent or inconsistent actual preset evidence $presets', async ({ presets }) => {
    const report = await runDsh(options, { createHarness: () => ({ close: async () => {}, run: async () => ({
      finalResponse: 'done', events: [...presets.map(agentPreset => ({ type: 'agent-preset/selected', data: { agentPreset } })),
        { type: 'turn/end', data: { reason: { kind: 'completed' } } }],
    }) }) });
    expect(report.finishReason).toBe('preset-not-confirmed');
  });

  it('preserves preset selection sent before the high-level SDK prompt receipt and releases its subscription', async () => {
    const notification = { method: 'session.event', params: { sessionId: options.sessionId,
      event: { type: 'agent-preset/selected', data: { agentPreset: 'standard' } } } };
    const queued = [notification];
    const closeSubscription = vi.fn();
    const report = await runDsh(options, { createHarness: () => ({
      client: { subscribe(filter) {
        expect(filter(notification)).toBe(true);
        expect(filter({ ...notification, params: { ...notification.params, sessionId: 'another' } })).toBe(false);
        return { tryNext: () => queued.shift(), close: closeSubscription };
      } },
      run: async () => ({ ...result('completed'), events: result('completed').events.slice(1) }), close: async () => {},
    }) });
    expect(report.finishReason).toBe('completed');
    expect(report.observedPresets).toEqual(['standard']);
    expect(closeSubscription).toHaveBeenCalledOnce();
  });

  it('rejects mismatched installations before the runtime factory is called', async () => {
    writeFileSync(join(options.dshRoot, 'apps/cli/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0' }));
    expect(() => checkDshInstallation(options.dshRoot)).toThrow('版本不一致');
    const createHarness = vi.fn((): DshHarness => ({ run: async () => result('completed'), close: async () => {} }));
    await expect(runDsh(options, { createHarness })).rejects.toThrow('版本不一致');
    expect(createHarness).not.toHaveBeenCalled();
  });
});
