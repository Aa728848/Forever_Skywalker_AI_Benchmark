import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import { createProviders, dshPatchText, providerListingUrl, readProviderListing } from './providers.ts';

/**
 * 供应商管理测试。
 * 全部使用系统临时目录：绝不写真实 data/provider-profiles.json，也绝不碰用户的
 * ~/.dsh。探测用 node:http 起的**本地假端点**，不联网。
 */

const token = 'provider-test-token-4a9f';
const roots: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'fsa-provider-test-'));
  roots.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of roots.splice(0)) {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('fsa-provider-test-')) throw new Error('临时目录不在测试范围内。');
    rmSync(target, { recursive: true, force: true });
  }
});

/** 项目根：写一份只含令牌的 .env，使写入路由可用；configEnv 显式注入，隔离真实环境。 */
function projectRoot(): string {
  const root = scratch();
  writeFileSync(join(root, '.env'), 'BENCH_RUN_TOKEN=' + token + '\n');
  return root;
}

interface Harness {
  app: ReturnType<typeof buildApp>;
  root: string;
  storePath: string;
  credentialsPath: string;
  profilePath: string;
}

/** 一个完整的测试夹具：临时项目根 + 临时档案/凭据/补丁层，目录读取恒为空。 */
function harness(extra: { probe?: (request: { baseURL: string; api: string; apiKey: string | undefined; timeoutMs: number }) => Promise<unknown> } = {}): Harness {
  const root = projectRoot();
  const storePath = join(root, 'profiles.json');
  const credentialsPath = join(root, '.credentials.yaml');
  const profilePath = join(root, 'dsh', 'profiles', 'sdk', 'cordis.patch.yml');
  mkdirSync(dirname(profilePath), { recursive: true });
  const app = buildApp(':memory:', {
    runRoot: join(root, 'runs'), configRoot: root,
    // configEnv 显式注入：既让令牌可用，又把 DSH 安装指到不存在的目录，
    // 使目录读取返回空（测试不依赖本机 DSH，也不读用户的 ~/.dsh）。
    configEnv: {
      BENCH_RUN_TOKEN: token, BENCH_DSH_ROOT: join(root, 'missing-dsh'),
      BENCH_DSH_HOME: join(root, 'missing-home'), BENCH_DSH_PROFILE: 'sdk',
    },
    providersStorePath: storePath, providersCredentialsPath: credentialsPath, providersProfilePath: profilePath,
    launchesRoot: join(root, 'launches'),
    ...(extra.probe === undefined ? {} : { providersProbe: extra.probe as never }),
  });
  return { app, root, storePath, credentialsPath, profilePath };
}

const provider = (id: string, extra: Record<string, unknown> = {}) => ({
  id, displayName: '项目网关', api: 'openai-completions', baseURL: 'https://project.invalid/v1', apiKeyEnv: 'PROJECT_GW_KEY',
  models: [{ id: 'project-model', name: 'Project', contextWindow: 131072, maxTokens: 8192, input: ['text', 'image'],
    reasoningEfforts: { off: null, low: 'low', high: 'high' } }],
  ...extra,
});

const put = (harnessed: Harness, id: string, payload: Record<string, unknown>, headers: Record<string, string> = { 'x-bench-token': token }) =>
  harnessed.app.inject({ method: 'PUT', url: '/api/providers/' + id, headers, payload });

describe('供应商档案读写', () => {
  it('GET 不需要令牌，返回空档案与两份来源说明', async () => {
    const h = harness();
    try {
      const response = await h.app.inject('/api/providers');
      expect(response.statusCode).toBe(200);
      const view = response.json();
      expect(view.providers).toEqual([]);
      expect(view.storePath).toBe(h.storePath);
      expect(view.dshProfilePath).toBe(h.profilePath);
      expect(typeof view.sources.project).toBe('string');
      expect(typeof view.sources.dshPatch).toBe('string');
    } finally { await h.app.close(); }
  });

  it('PUT 落盘到项目档案，GET 读回同一份并带上凭据的「已配置」布尔值', async () => {
    const h = harness();
    try {
      // 凭据库里只有引用名（值只是为了证明它不会外泄）。
      writeFileSync(h.credentialsPath, ['version: 1', 'refs:', '  PROJECT_GW_KEY: stored-secret-value', ''].join('\n'));
      const saved = await put(h, 'project-gw', provider('project-gw'));
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({ changed: true, provider: { id: 'project-gw', source: 'project', apiKeyEnv: 'PROJECT_GW_KEY', keyConfigured: true } });
      const onDisk = JSON.parse(readFileSync(h.storePath, 'utf8'));
      expect(onDisk.version).toBe(1);
      expect(Object.keys(onDisk.providers)).toEqual(['project-gw']);
      // 密钥永不入库：写盘内容里只有引用名。
      expect(readFileSync(h.storePath, 'utf8')).not.toContain('stored-secret-value');
      const listed = (await h.app.inject('/api/providers')).json();
      expect(listed.providers).toHaveLength(1);
      expect(listed.providers[0]).toMatchObject({ id: 'project-gw', keyConfigured: true });
      expect(listed.providers[0].models[0]).toMatchObject({ id: 'project-model', input: ['text', 'image'], reasoningEfforts: { off: null, low: 'low', high: 'high' } });
      expect(JSON.stringify(listed)).not.toContain('stored-secret-value');
    } finally { await h.app.close(); }
  });

  it('未带令牌的写请求一律 401，且不改动档案', async () => {
    const h = harness();
    try {
      expect((await put(h, 'project-gw', provider('project-gw'), {})).statusCode).toBe(401);
      expect((await put(h, 'project-gw', provider('project-gw'), { 'x-bench-token': 'wrong' })).statusCode).toBe(401);
      expect((await h.app.inject({ method: 'DELETE', url: '/api/providers/project-gw' })).statusCode).toBe(401);
      expect((await h.app.inject({ method: 'POST', url: '/api/providers/project-gw/export-dsh', payload: { confirm: true } })).statusCode).toBe(401);
      expect(existsSync(h.storePath)).toBe(false);
    } finally { await h.app.close(); }
  });

  it('校验失败按字段就地报错，档案不被写入', async () => {
    const h = harness();
    try {
      for (const [payload, field] of [
        [provider('project-gw', { api: 'grpc' }), 'api'],
        [provider('project-gw', { baseURL: 'ftp://host/v1' }), 'baseURL'],
        [provider('project-gw', { baseURL: 'https://user:pass@host/v1' }), 'baseURL'],
        [provider('project-gw', { apiKeyEnv: 'not a ref' }), 'apiKeyEnv'],
        [provider('project-gw', { models: [] }), 'models'],
        [provider('project-gw', { models: [{ id: 'a' }, { id: 'a' }] }), 'models[1].id'],
        [provider('project-gw', { models: [{ id: 'a', reasoningEfforts: { medium: '' } }] }), 'models[0].reasoningEfforts.medium'],
        [provider('project-gw', { models: [{ id: 'a', reasoningEfforts: { off: null } }] }), 'models[0].reasoningEfforts'],
        [provider('project-gw', { models: [{ id: 'a', input: ['video'] }] }), 'models[0].input'],
      ] as const) {
        const response = await put(h, 'project-gw', payload);
        expect(response.statusCode, JSON.stringify(payload)).toBe(400);
        expect(response.json().errors.map((entry: { field: string }) => entry.field)).toContain(field);
      }
      expect((await put(h, 'bad id', provider('bad id'))).statusCode).toBe(400);
      expect((await put(h, '-leading', provider('-leading'))).statusCode).toBe(400);
      expect(existsSync(h.storePath)).toBe(false);
    } finally { await h.app.close(); }
  });

  it('DELETE 移除项目供应商；删不存在的是 404', async () => {
    const h = harness();
    try {
      await put(h, 'project-gw', provider('project-gw'));
      expect((await h.app.inject({ method: 'DELETE', url: '/api/providers/missing', headers: { 'x-bench-token': token } })).statusCode).toBe(404);
      const removed = await h.app.inject({ method: 'DELETE', url: '/api/providers/project-gw', headers: { 'x-bench-token': token } });
      expect(removed.statusCode).toBe(200);
      expect(removed.json()).toEqual({ removed: true });
      expect((await h.app.inject('/api/providers')).json().providers).toEqual([]);
    } finally { await h.app.close(); }
  });

  it('目录里同名的补丁层供应商被项目档案顶掉，只列一次', async () => {
    const h = harness();
    try {
      await put(h, 'stepfun', provider('stepfun'));
      const providers = createProviders({
        storePath: h.storePath, credentialsPath: h.credentialsPath, dshProfilePath: h.profilePath,
        env: () => ({}),
        catalog: async () => ({ providers: [
          { id: 'stepfun', name: 'patch-stepfun', models: [{ id: 'patch-model', name: 'Patch', reasoningEfforts: [] }], source: 'dsh-patch' },
          { id: 'other', name: 'Other', models: [{ id: 'other-model', name: 'Other', reasoningEfforts: [] }], source: 'dsh-patch' },
        ], warning: null }),
      });
      const list = await providers.list();
      expect(list.providers.map(item => item.id)).toEqual(['stepfun', 'other']);
      expect(list.providers[0]).toMatchObject({ source: 'project', displayName: '项目网关' });
      expect(list.providers[1]).toMatchObject({ source: 'dsh-patch', api: '', baseURL: '' });
    } finally { await h.app.close(); }
  });
});

describe('端点探测', () => {
  /** 本地假端点：记录请求方法、路径与鉴权头，回复一份可控的正文。 */
  async function fakeEndpoint(handler: (request: { method: string; url: string; headers: Record<string, string | string[] | undefined> }) => { status?: number; body?: string }) {
    const requests: { method: string; url: string; headers: Record<string, string | string[] | undefined> }[] = [];
    const server: Server = createServer((request, response) => {
      requests.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers });
      const reply = handler(requests[requests.length - 1]!);
      response.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      response.end(reply.body ?? '{"data":[]}');
    });
    await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('假端点没有端口。');
    return { url: 'http://127.0.0.1:' + String(address.port) + '/v1', close: () => new Promise<void>(resolveClose => server.close(() => resolveClose())), requests };
  }

  it('openai-completions 走 bearer auth 打 {baseURL}/models，返回的模型可供勾选', async () => {
    const endpoint = await fakeEndpoint(() => ({ body: JSON.stringify({ data: [
      { id: 'model-a', name: 'Model A', context_length: 200000, max_output_tokens: 4096 },
      { id: 'model-b', context_window: 1000 },
      { not_a_model: true },
    ] }) }));
    const h = harness();
    try {
      writeFileSync(h.credentialsPath, ['refs:', '  PROJECT_GW_KEY: probe-secret-9c', ''].join('\n'));
      const response = await h.app.inject({ method: 'POST', url: '/api/providers/probe', headers: { 'x-bench-token': token },
        payload: { baseURL: endpoint.url, api: 'openai-completions', apiKeyEnv: 'PROJECT_GW_KEY' } });
      expect(response.statusCode).toBe(200);
      const result = response.json();
      expect(result.protocol).toBe('listable');
      expect(result.models).toEqual([
        { id: 'model-a', name: 'Model A', contextWindow: 200000, maxTokens: 4096 },
        { id: 'model-b', contextWindow: 1000 },
      ]);
      expect(result.apiKeyEnv).toBe('PROJECT_GW_KEY');
      expect(result.keyConfigured).toBe(true);
      expect(response.body).not.toContain('probe-secret-9c');
      expect(endpoint.requests[0]!.url).toBe('/v1/models');
      expect(endpoint.requests[0]!.headers.authorization).toBe('Bearer probe-secret-9c');
      // 不落盘：探测不会创建或改动档案。
      expect(existsSync(h.storePath)).toBe(false);
    } finally { await endpoint.close(); await h.app.close(); }
  });

  it('anthropic-messages 用 x-api-key 与 anthropic-version 打 /v1/models，并去掉多余的结尾 /v1', async () => {
    const endpoint = await fakeEndpoint(() => ({ body: JSON.stringify({ models: { 'claude-x': { display_name: 'Claude X', limit: { context: 200000, output: 8192 } } } }) }));
    const h = harness();
    try {
      writeFileSync(h.credentialsPath, ['refs:', '  ANTHROPIC_KEY: anthropic-secret-7d', ''].join('\n'));
      const response = await h.app.inject({ method: 'POST', url: '/api/providers/probe', headers: { 'x-bench-token': token },
        payload: { baseURL: endpoint.url, api: 'anthropic-messages', apiKeyEnv: 'ANTHROPIC_KEY' } });
      expect(response.statusCode).toBe(200);
      expect(response.json().models).toEqual([{ id: 'claude-x', name: 'Claude X', contextWindow: 200000, maxTokens: 8192 }]);
      expect(response.body).not.toContain('anthropic-secret-7d');
      expect(endpoint.requests[0]!.url).toBe('/v1/models?limit=1000');
      expect(endpoint.requests[0]!.headers['x-api-key']).toBe('anthropic-secret-7d');
      expect(endpoint.requests[0]!.headers['anthropic-version']).toBe('2023-06-01');
      expect(endpoint.requests[0]!.headers.authorization).toBeUndefined();
    } finally { await endpoint.close(); await h.app.close(); }
  });

  it('不在允许集合内的协议被拒绝，不发请求也不猜字段', async () => {
    const endpoint = await fakeEndpoint(() => ({}));
    const h = harness();
    try {
      const response = await h.app.inject({ method: 'POST', url: '/api/providers/probe', headers: { 'x-bench-token': token },
        payload: { baseURL: endpoint.url, api: 'bedrock-converse' } });
      expect(response.statusCode).toBe(400);
      expect(endpoint.requests).toHaveLength(0);
    } finally { await endpoint.close(); await h.app.close(); }
  });

  it('探测实现如实回答「无法探测」时路由原样带回', async () => {
    const h = harness({ probe: async () => ({ models: [], protocol: 'not-listable', note: '协议 anthropic-messages 没有本版本能读的模型列表端点；请手工填写模型。' }) });
    try {
      const response = await h.app.inject({ method: 'POST', url: '/api/providers/probe', headers: { 'x-bench-token': token },
        payload: { baseURL: 'https://project.invalid/v1', api: 'anthropic-messages' } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ protocol: 'not-listable', models: [] });
    } finally { await h.app.close(); }
  });

  it('探测失败返回结构化原因，不含端点原文、正文或密钥', async () => {
    const endpoint = await fakeEndpoint(() => ({ status: 401, body: '{"error":"bad key probe-secret-9c"}' }));
    const h = harness();
    try {
      writeFileSync(h.credentialsPath, ['refs:', '  PROJECT_GW_KEY: probe-secret-9c', ''].join('\n'));
      const response = await h.app.inject({ method: 'POST', url: '/api/providers/probe', headers: { 'x-bench-token': token },
        payload: { baseURL: endpoint.url, api: 'openai-completions', apiKeyEnv: 'PROJECT_GW_KEY' } });
      expect(response.statusCode).toBe(502);
      expect(response.body).toContain('HTTP 401');
      expect(response.body).not.toContain('probe-secret-9c');
      expect(response.body).not.toContain('bad key');
      expect(response.body).not.toContain(endpoint.url);
    } finally { await endpoint.close(); await h.app.close(); }
  });

  it('端点回复不是模型列表时给出可行动原因，不回传响应正文', async () => {
    const endpoint = await fakeEndpoint(() => ({ body: 'not json at all' }));
    const h = harness();
    try {
      const response = await h.app.inject({ method: 'POST', url: '/api/providers/probe', headers: { 'x-bench-token': token },
        payload: { baseURL: endpoint.url, api: 'openai-completions' } });
      expect(response.statusCode).toBe(502);
      expect(response.json().error).toContain('JSON');
      expect(response.body).not.toContain('not json at all');
    } finally { await endpoint.close(); await h.app.close(); }
  });

  it('未带令牌的探测 401，且不发起任何请求', async () => {
    const h = harness({ probe: async () => { throw new Error('不该被调用'); } });
    try {
      expect((await h.app.inject({ method: 'POST', url: '/api/providers/probe', payload: { baseURL: 'https://project.invalid/v1', api: 'openai-completions' } })).statusCode).toBe(401);
    } finally { await h.app.close(); }
  });
});

describe('导出到 DSH 补丁层', () => {
  it('未确认时只回传将写入的内容，绝不碰目标文件', async () => {
    const h = harness();
    try {
      writeFileSync(h.profilePath, '- id: kept\n');
      await put(h, 'project-gw', provider('project-gw'));
      const response = await h.app.inject({ method: 'POST', url: '/api/providers/project-gw/export-dsh', headers: { 'x-bench-token': token }, payload: {} });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ written: false, backupPath: null, profilePath: h.profilePath });
      expect(response.json().content).toContain('fsa-pi-ai-providers');
      expect(readFileSync(h.profilePath, 'utf8')).toBe('- id: kept\n');
      expect(readdirSync(dirname(h.profilePath)).filter(name => name.startsWith('.backup-'))).toEqual([]);
    } finally { await h.app.close(); }
  });

  it('确认后先备份再写，返回备份路径；内容是覆盖式的两层补丁', async () => {
    const h = harness();
    try {
      writeFileSync(h.profilePath, '- id: kept\n');
      await put(h, 'project-gw', provider('project-gw'));
      const response = await h.app.inject({ method: 'POST', url: '/api/providers/project-gw/export-dsh', headers: { 'x-bench-token': token }, payload: { confirm: true } });
      expect(response.statusCode).toBe(200);
      const result = response.json();
      expect(result.written).toBe(true);
      expect(result.backupPath).toMatch(/\.backup-\d{8}-\d{6}$/);
      expect(readFileSync(result.backupPath, 'utf8')).toBe('- id: kept\n');
      const written = readFileSync(h.profilePath, 'utf8');
      expect(written).toContain('fsa-pi-ai-providers');
      expect(written).toContain('https://project.invalid/v1');
      // 档案只存引用名：导出内容里没有密钥值。
      expect(written).not.toContain('stored-secret-value');
    } finally { await h.app.close(); }
  });

  it('目标 profile 不存在时拒绝写入，不在用户 home 下凭空造 profile', async () => {
    const h = harness();
    try {
      await put(h, 'project-gw', provider('project-gw'));
      rmSync(dirname(h.profilePath), { recursive: true, force: true });
      const response = await h.app.inject({ method: 'POST', url: '/api/providers/project-gw/export-dsh', headers: { 'x-bench-token': token }, payload: { confirm: true } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain('不存在');
      expect(existsSync(h.profilePath)).toBe(false);
    } finally { await h.app.close(); }
  });

  it('导出不存在的供应商是 404', async () => {
    const h = harness();
    try {
      const response = await h.app.inject({ method: 'POST', url: '/api/providers/missing/export-dsh', headers: { 'x-bench-token': token }, payload: { confirm: true } });
      expect(response.statusCode).toBe(404);
    } finally { await h.app.close(); }
  });

  it('导出片段是固定行 id 的 insert + 覆盖配置，正文是 YAML 1.2 子集', () => {
    const text = dshPatchText({
      id: 'project-gw', displayName: '项目网关', api: 'openai-completions', baseURL: 'https://project.invalid/v1', apiKeyEnv: 'PROJECT_GW_KEY',
      models: [{ id: 'project-model', contextWindow: 1000, input: ['text'], reasoningEfforts: { off: null, low: 'low' } }],
    });
    expect(text.split('\n').filter(line => line.startsWith('- insert:'))).toHaveLength(1);
    expect(text.split('\n').filter(line => line === '- id: fsa-pi-ai-providers')).toHaveLength(1);
    expect(text).toContain('"apiKeyEnv": "PROJECT_GW_KEY"');
    expect(text).toContain('"off": null');
  });
});

describe('探测协议的边界（纯函数）', () => {
  it('列表地址与 DSH discovery.ts 一致', () => {
    expect(providerListingUrl('https://gw.invalid/v1', 'openai-completions')).toBe('https://gw.invalid/v1/models');
    expect(providerListingUrl('https://gw.invalid/v1/', 'openai-responses')).toBe('https://gw.invalid/v1/models');
    expect(providerListingUrl('https://gw.invalid/v1', 'anthropic-messages')).toBe('https://gw.invalid/v1/models?limit=1000');
    expect(providerListingUrl('https://gw.invalid', 'anthropic-messages')).toBe('https://gw.invalid/v1/models?limit=1000');
  });

  it('models 字典用属性名作 id，坏记录跳过；既非 data 也非 models 时拒绝', () => {
    expect(readProviderListing({ models: { 'gw-model': { name: 'GW', limit: { context: 10, output: 2 } }, meta: 'not-an-object' } }))
      .toEqual([{ id: 'gw-model', name: 'GW', contextWindow: 10, maxTokens: 2 }]);
    expect(() => readProviderListing({ objects: [] })).toThrow();
  });
});
