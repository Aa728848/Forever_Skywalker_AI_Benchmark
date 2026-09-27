import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkDshInstallation, checkDshPresetAssets, DshCleanupError, dshReviewPreset, emptyProviderStore, resolveDshPreset, resolveDshWorkspacePermission, runDsh, validateProviderProfile, type DshHarness, type DshRunOptions, type ProjectProviderStore } from './dsh.ts';

let temporaryRoot: string;
let options: DshRunOptions;

/** 新版 DSH 的预设资产：一层只插入一条声明的补丁文件。 */
function presetPatchText(id: string, order: number): string {
  return [
    '# Agent preset ' + id,
    '- insert:',
    '    - id: preset-' + id,
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: ' + id,
    '        order: ' + String(order),
    '        plugins:',
    '          - id: persona',
    "            name: '@deepseek-ai/dsh-persona'",
    '            config:',
    '              prefix: benchmark persona',
    '',
  ].join('\n');
}

beforeEach(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), 'fsa-dsh-adapter-'));
  const dshRoot = join(temporaryRoot, 'dsh');
  for (const [path, content] of [
    ['packages/sdk/client/package.json', JSON.stringify({ name: '@deepseek-ai/dsh-sdk-client', version: '0.1.5' })],
    ['apps/cli/package.json', JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5' })],
    ['packages/sdk/client/lib/index.js', 'throw new Error("fake must use injected SDK")'],
    ['apps/cli/lib/bin.js', 'throw new Error("fake CLI must not start")'],
    ['packages/core/scope/lib/index.js', 'export const createScope = () => {};'],
    ['packages/preset/agent-preset-registry/lib/index.js', 'export default {};'],
    ['packages/bundle/web-app/cordis.patch.yml', '# ── the agent plane moves behind agent presets\n- id: tool-bash\n  disabled: true\n- id: tool-fs\n  disabled: true\n# The preset roster.'],
    ...['standard', 'ptc', 'minimal', 'cordis'].map((id, index) => [`packages/bundle/web-app/presets/${id}.patch.yml`, presetPatchText(id, index + 1)]),
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
      expect(launch.env).toEqual({ PATH: 'runtime-path', DEEPSEEK_API_KEY: 'solver-secret', DSH_HOME: options.dshHome, DSH_PERMISSION_MODE: 'workspace-write', DSH_TELEMETRY_DISABLED: '1' });
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

  it.each([
    { provider: 'gateway-a', effort: 'default' },
    { provider: 'gateway-b', effort: 'default' },
    { provider: 'gateway-a', effort: 'off' },
    { provider: 'gateway-b', effort: 'high' },
  ])('keeps $provider identity and sends only an explicit $effort control', async ({ provider, effort }) => {
    const report = await runDsh({ ...options, provider, model: 'same-model', reasoningEffort: effort }, {
      createHarness(launch) {
        expect(launch.provider).toBe(provider); expect(launch.model).toBe('same-model');
        if (effort === 'default') {
          // 与 DSH 无推理元数据的模型边界一致：任何显式字段（包括 off/default）都会被拒绝。
          if (Object.hasOwn(launch, 'reasoningEffort')) throw new Error('UNSUPPORTED_REASONING_EFFORT');
        } else expect(launch.reasoningEffort).toBe(effort);
        return { close: async () => {}, run: async () => ({ finalResponse: 'done', events: [
          { type: 'agent-preset/selected', data: { agentPreset: 'standard' } },
          { type: 'assistant/message', data: { message: { source: { provider, model: 'same-model' } } } },
          { type: 'turn/end', data: { reason: { kind: 'completed' } } },
        ] }) };
      },
    });
    expect(report.finishReason).toBe('completed');
    expect(report.requestedModel).toMatchObject({ provider, model: 'same-model', reasoningEffort: effort === 'default' ? null : effort });
    expect(report.observedRoutes).toEqual([{ provider, model: 'same-model' }]);
  });

  it('透传 DSH 工作区权限环境变量并保持 BENCH 控制变量隔离', async () => {
    const createHarness = vi.fn((launch) => {
      expect(launch.env.DSH_PERMISSION_MODE).toBe('read-only');
      expect(launch.env.BENCH_DSH_WORKSPACE_PERMISSION).toBeUndefined();
      return { close: async () => {}, run: async () => ({ ...result('completed'), events: [
        { type: 'agent-preset/selected', data: { agentPreset: 'standard' } },
        { type: 'turn/end', data: { reason: { kind: 'completed' } } },
      ] }) };
    });
    const report = await runDsh({ ...options, env: {
      PATH: 'runtime-path', DSH_PERMISSION_MODE: 'read-only',
    } }, { createHarness });
    expect(report.finishReason).toBe('completed');
    expect(createHarness).toHaveBeenCalledOnce();
  });

  it('显式工作区权限优先于环境变量，并拒绝未知值', async () => {
    const createHarness = vi.fn((launch) => {
      expect(launch.env.DSH_PERMISSION_MODE).toBe('danger-full-access');
      return { close: async () => {}, run: async () => ({ ...result('completed'), events: [
        { type: 'agent-preset/selected', data: { agentPreset: 'standard' } },
        { type: 'turn/end', data: { reason: { kind: 'completed' } } },
      ] }) };
    });
    await expect(runDsh({ ...options, workspacePermission: 'danger-full-access', env: {
      DSH_PERMISSION_MODE: 'read-only',
    } }, { createHarness })).resolves.toMatchObject({ finishReason: 'completed' });
    expect(resolveDshWorkspacePermission('full')).toBe('danger-full-access');
    expect(() => resolveDshWorkspacePermission('invalid')).toThrow('工作区权限');
    expect(() => resolveDshWorkspacePermission('toString')).toThrow('工作区权限');
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
      // 新版由注册表行 + @deepseek-ai/dsh-agent-preset 声明承担预设，不再有 roster 模块与 roots 配置。
      const inserted = patch.flatMap(item => Array.isArray(item.insert) ? item.insert : []) as Record<string, unknown>[];
      expect(inserted).toContainEqual(expect.objectContaining({
        id: 'agent-preset-registry', config: { default: 'cordis' },
      }));
      expect(JSON.stringify(patch)).not.toContain('agent-presets');
      expect(JSON.stringify(patch)).not.toContain('includeShippedRoot');
      // 预设资产（含 cordis 自己的声明）整份作为第二层补丁交付。
      const presetPatch = readFileSync(launch.patches[1]!, 'utf8');
      expect(presetPatch).toBe(presetPatchText('cordis', 4));
      expect(presetPatch).toContain("name: '@deepseek-ai/dsh-agent-preset'");
      const text = readFileSync(join(options.scratchDirectory!, 'preset-bridge.mjs'), 'utf8');
      expect(text).toContain('await ctx.agentPresets.mount(parent.ctx, presetId)');
      expect(text).toContain("ctx.agentPresets.composeFrom(agent.ctx, parent.ctx)");
      expect(text).toContain("const presetId = \"cordis\"");
      expect(text).toContain('await ctx.agentPresets.list()');
      expect(launch.dshHome).toBe(options.dshHome);
      return { close: async () => {}, run: async () => ({ ...result('completed'), events: [
        { type: 'agent-preset/selected', data: { agentPreset: 'cordis' } }, ...result('completed').events.slice(1),
      ] }) };
    } });
    expect(report.requestedPreset).toBe('cordis');
    expect(report.observedPresets).toEqual(['cordis']);
    expect(report.presetFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('review-only 会话只装载评分 persona 并生成无工具限制', async () => {
    const report = await runDsh({ ...options, reviewOnly: true, agentPreset: 'minimal', scratchDirectory: join(options.scratchDirectory!, 'review') }, { createHarness: launch => {
      const patch = JSON.parse(readFileSync(launch.patches[0]!, 'utf8')) as Array<Record<string, unknown>>;
      const inserted = patch.flatMap(item => Array.isArray(item.insert) ? item.insert : []) as Record<string, unknown>[];
      expect(inserted).toContainEqual(expect.objectContaining({ id: 'agent-preset-registry', config: { default: 'minimal' } }));
      // 评分会话不再读随发行版的预设，而是自带一条只含评分 persona 的声明补丁层。
      const presetPatch = readFileSync(launch.patches[1]!, 'utf8');
      expect(presetPatch).toContain("name: '@deepseek-ai/dsh-agent-preset'");
      expect(presetPatch).toContain('id: minimal');
      expect(presetPatch).toContain(JSON.stringify(JSON.parse(dshReviewPreset)[0]));
      expect(readFileSync(join(options.scratchDirectory!, 'review', 'preset-bridge.mjs'), 'utf8')).toContain('tools.restrict({ allow: [] })');
      return { close: async () => {}, run: async () => {
        const bridge = await import(pathToFileURL(join(options.scratchDirectory!, 'review', 'preset-bridge.mjs')).href);
        expect(bridge.inject).toContain('tools');
        return { ...result('completed'), events: [{ type: 'agent-preset/selected', data: { agentPreset: 'minimal' } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } }] };
      } };
    } });
    expect(report.finishReason).toBe('completed');
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

  it('在新版 DSH 布局下不再引用已删除的预设路径，并产出 @deepseek-ai/dsh-agent-preset 声明', async () => {
    // 旧实现读 packages/preset/agent-presets/**，在 0.1.7-rc.2 上直接 ENOENT。
    const report = await runDsh({ ...options, agentPreset: 'standard' }, { createHarness: launch => {
      expect(launch.patches).toHaveLength(2);
      // 旧实现把已删除的 packages/preset/agent-presets/** 写进补丁并读它的预设源码。
      for (const file of launch.patches) expect(readFileSync(file, 'utf8')).not.toContain('agent-presets');
      expect(readFileSync(launch.patches[0]!, 'utf8')).not.toContain('agent.cordis.yml');
      const rows = JSON.parse(readFileSync(launch.patches[0]!, 'utf8')) as Record<string, unknown>[];
      const inserted = rows.flatMap(row => Array.isArray(row.insert) ? row.insert : []) as Record<string, unknown>[];
      // 注册表按新版 schema 只给 default；已删除的 roots/includeShippedRoot 不得再出现。
      expect(inserted).toContainEqual(expect.objectContaining({ id: 'agent-preset-registry', config: { default: 'standard' } }));
      expect(JSON.stringify(rows)).not.toContain('includeShippedRoot');
      // 预设资产按 DSH 自己的装载方式整份作为第二层补丁交付，声明就在里面。
      expect(launch.patches[1]).toBe(join(options.scratchDirectory!, 'preset.patch.yml'));
      expect(readFileSync(launch.patches[1]!, 'utf8')).toBe(presetPatchText('standard', 1));
      return { close: async () => {}, run: async () => result('completed') };
    } });
    expect(report.requestedPreset).toBe('standard');
    expect(report.presetFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('指纹跟随本次实际挂载的预设内容变化，不退化成一个常量', async () => {
    const fingerprintFor = async (agentPreset: 'standard' | 'ptc', tag: string) => (await runDsh({ ...options, agentPreset, scratchDirectory: join(options.scratchDirectory!, tag) },
      { createHarness: () => ({ close: async () => {}, run: async () => ({ ...result('completed'), events: [
        { type: 'agent-preset/selected', data: { agentPreset } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } }] }) }) })).presetFingerprint;
    const standard = await fingerprintFor('standard', 'first');
    const ptc = await fingerprintFor('ptc', 'second');
    expect(standard).not.toBe(ptc);
    writeFileSync(join(options.dshRoot, 'packages/bundle/web-app/presets/standard.patch.yml'), presetPatchText('standard', 9));
    expect(await fingerprintFor('standard', 'third')).not.toBe(standard);
  });

  it('--check 的预设前置条件能识破缺失的预设资产，且不启动 DSH', () => {
    expect(checkDshPresetAssets(options.dshRoot, ['standard', 'ptc', 'minimal', 'cordis'])).toEqual([
      'packages/bundle/web-app/presets/standard.patch.yml', 'packages/bundle/web-app/presets/ptc.patch.yml',
      'packages/bundle/web-app/presets/minimal.patch.yml', 'packages/bundle/web-app/presets/cordis.patch.yml',
    ]);
    rmSync(join(options.dshRoot, 'packages/bundle/web-app/presets/cordis.patch.yml'));
    expect(() => checkDshPresetAssets(options.dshRoot, ['cordis'])).toThrow('ENOENT');
    rmSync(join(options.dshRoot, 'packages/preset/agent-preset-registry/lib/index.js'));
    expect(() => checkDshPresetAssets(options.dshRoot, ['standard'])).toThrow('ENOENT');
  });

  it('rejects mismatched installations before the runtime factory is called', async () => {
    writeFileSync(join(options.dshRoot, 'apps/cli/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0' }));
    expect(() => checkDshInstallation(options.dshRoot)).toThrow('版本不一致');
    const createHarness = vi.fn((): DshHarness => ({ run: async () => result('completed'), close: async () => {} }));
    await expect(runDsh(options, { createHarness })).rejects.toThrow('版本不一致');
    expect(createHarness).not.toHaveBeenCalled();
  });
});

describe('项目供应商档案作为 launch patch 层注入作答会话', () => {
  // 回归（S2）：网页配好的供应商必须**真的**能被作答会话解析到。档案层排在
  // --patch 顺序的最后，因此项目档案与 profile 补丁层冲突时以项目档案为准；
  // 档案为空时一层都不产生，会话挂载内容与改动前完全相同。
  const storeOf = (raw: Record<string, unknown>): ProjectProviderStore => {
    const store = emptyProviderStore();
    for (const [id, value] of Object.entries(raw)) {
      const { profile, errors } = validateProviderProfile(id, value);
      expect(errors).toEqual([]);
      store.providers[id] = profile!;
    }
    return store;
  };
  const projectStore = storeOf({
    'project-gw': {
      displayName: '项目网关', api: 'openai-completions', baseURL: 'https://project.invalid/v1', apiKeyEnv: 'PROJECT_GW_KEY',
      models: [{ id: 'project-model', name: 'Project', contextWindow: 131072, maxTokens: 8192, input: ['text', 'image'],
        reasoningEfforts: { off: null, low: 'low' } }],
    },
  });

  it('把项目档案写成一个额外补丁层，并计入指纹', async () => {
    const seen: string[][] = [];
    const runWith = async (tag: string, providerStore: ProjectProviderStore) => runDsh(
      { ...options, scratchDirectory: join(options.scratchDirectory!, tag), providerStore },
      { createHarness: launch => { seen.push(launch.patches); return { close: async () => {}, run: async () => result('completed') }; } });
    const report = await runWith('with-project', projectStore);
    expect(seen[0]).toHaveLength(3);
    // 第 0 层是本项目的 launch 补丁，第 1 层是预设声明，第 2 层是项目供应商档案。
    expect(seen[0]![0]).toBe(join(options.scratchDirectory!, 'with-project', 'launch.patch.json'));
    const rows = JSON.parse(readFileSync(seen[0]![2]!, 'utf8')) as Record<string, unknown>[];
    // 先 insert 再按 id 配置：无论 profile 补丁层有没有这一行，会话里只挂载一条项目路由集。
    expect(rows[0]).toMatchObject({ insert: [{ id: 'fsa-pi-ai-providers', name: '@deepseek-ai/dsh-llm-pi-ai' }] });
    expect(rows[1]).toMatchObject({ id: 'fsa-pi-ai-providers' });
    const providers = (rows[1]!.config as { providers: Record<string, unknown> }).providers;
    expect(Object.keys(providers)).toEqual(['project-gw']);
    expect(providers['project-gw']).toMatchObject({
      displayName: '项目网关', api: 'openai-completions', baseURL: 'https://project.invalid/v1', apiKeyEnv: 'PROJECT_GW_KEY',
      models: [{ id: 'project-model', name: 'Project', contextWindow: 131072, maxTokens: 8192, input: ['text', 'image'],
        reasoningEfforts: { off: null, low: 'low' } }],
    });
    // 档案只存引用名：注入层里绝不能出现密钥值本身。
    expect(readFileSync(seen[0]![2]!, 'utf8')).not.toContain('sk-');
    // 指纹必须把这一层算进去：否则改了供应商档案，两次不可比的作答会被当成同一条件。
    const without = await runWith('without-project', emptyProviderStore());
    expect(report.presetFingerprint).not.toBe(without.presetFingerprint);
    expect(seen[1]).toHaveLength(2);
  });

  it('档案为空时不产生额外层', async () => {
    const patchesOf = async (tag: string, providerStore?: ProjectProviderStore) => {
      let patches: string[] = [];
      await runDsh({ ...options, scratchDirectory: join(options.scratchDirectory!, tag), ...(providerStore === undefined ? {} : { providerStore }) },
        { createHarness: launch => { patches = launch.patches; return { close: async () => {}, run: async () => result('completed') }; } });
      return patches;
    };
    expect(await patchesOf('empty-store', emptyProviderStore())).toHaveLength(2);
    expect(await patchesOf('absent-store')).toHaveLength(2);
  });

  it('启动补丁层本身仍描述预设与运行时，不因注入供应商层而改变', async () => {
    await runDsh({ ...options, scratchDirectory: join(options.scratchDirectory!, 'unchanged'), providerStore: projectStore },
      { createHarness: launch => {
        const rows = JSON.parse(readFileSync(launch.patches[0]!, 'utf8')) as Record<string, unknown>[];
        const inserted = rows.flatMap(item => Array.isArray(item.insert) ? item.insert : []) as Record<string, unknown>[];
        expect(inserted).toContainEqual(expect.objectContaining({ id: 'agent-preset-registry' }));
        expect(inserted.some(item => item.id === 'fsa-pi-ai-providers')).toBe(false);
        expect(readFileSync(launch.patches[1]!, 'utf8')).toBe(presetPatchText('standard', 1));
        return { close: async () => {}, run: async () => result('completed') };
      } });
  });
});

