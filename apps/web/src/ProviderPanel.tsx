import { useCallback, useEffect, useState } from 'react';

/**
 * 「供应商」页签：管理本项目自己的 pi-ai 供应商档案。
 *
 * 边界（与后端 apps/api/src/providers.ts 一一对应）：
 * - 密钥永不回显：这里只填**凭据引用名**，界面只显示「已配置 / 未配置」。
 * - 令牌存在浏览器本地，写请求带 x-bench-token；401 时清空并要求重新输入。
 * - 来源为 dsh-patch 的路由只读（它属于 DSH profile 补丁层）。
 */

/** 令牌只存在浏览器本地：与 ConfigPanel 同一个键，两个页签共享一次输入。 */
const tokenStorageKey = 'fsa.bench-token';

const apiChoices = [
  ['openai-completions', 'OpenAI 兼容（chat completions）'],
  ['openai-responses', 'OpenAI Responses'],
  ['anthropic-messages', 'Anthropic Messages'],
] as const;
const thinkingFormats = ['openai', 'deepseek', 'openrouter', 'together', 'baseten', 'zai', 'qwen', 'chat-template', 'qwen-chat-template', 'string-thinking', 'ant-ling'] as const;
const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const modalities = [['text', '文本'], ['image', '图片']] as const;

interface ModelDraft {
  id: string;
  name: string;
  contextWindow: string;
  maxTokens: string;
  input: string[];
  /** 等级 → 拼写；'' 表示留空（仅 off 允许）。没有该等级时键不存在。 */
  efforts: Record<string, string>;
  /** inherit = 整项留空沿用目录能力；false = 不支持推理；declare = 声明等级表。 */
  reasoning: 'inherit' | 'false' | 'declare';
}

interface ProviderDraft {
  id: string;
  displayName: string;
  api: string;
  baseURL: string;
  apiKeyEnv: string;
  thinkingFormat: string;
  models: ModelDraft[];
}

interface ProviderRow {
  id: string;
  displayName: string | null;
  api: string;
  baseURL: string;
  compat: { thinkingFormat?: string } | null;
  apiKeyEnv: string | null;
  keyConfigured: boolean;
  source: 'project' | 'dsh-patch';
  models: { id: string; name: string | null; contextWindow: number | null; maxTokens: number | null; input: string[]; reasoningEfforts: Record<string, string | null> | false | null }[];
}

interface ProviderList {
  providers: ProviderRow[];
  storePath: string;
  dshProfilePath: string;
  sources: { project: string; dshPatch: string };
}

interface ProbeResult {
  models: { id: string; name?: string; contextWindow?: number; maxTokens?: number }[];
  protocol: 'listable' | 'not-listable';
  note: string;
  keyConfigured: boolean;
}

interface FieldError { field: string; message: string }

const emptyModel = (id = ''): ModelDraft => ({ id, name: '', contextWindow: '', maxTokens: '', input: ['text'], efforts: {}, reasoning: 'inherit' });
const emptyDraft = (): ProviderDraft => ({ id: '', displayName: '', api: 'openai-completions', baseURL: '', apiKeyEnv: '', thinkingFormat: '', models: [emptyModel()] });

/** 从一行服务端视图还原成可编辑草案。 */
function draftOf(row: ProviderRow): ProviderDraft {
  return {
    id: row.id,
    displayName: row.displayName ?? '',
    api: row.api === '' ? 'openai-completions' : row.api,
    baseURL: row.baseURL,
    apiKeyEnv: row.apiKeyEnv ?? '',
    thinkingFormat: row.compat?.thinkingFormat ?? '',
    models: row.models.map(model => {
      const declared = model.reasoningEfforts;
      const efforts: Record<string, string> = {};
      if (declared !== null && declared !== false) for (const [level, wire] of Object.entries(declared)) efforts[level] = wire ?? '';
      return {
        id: model.id,
        name: model.name ?? '',
        contextWindow: model.contextWindow === null ? '' : String(model.contextWindow),
        maxTokens: model.maxTokens === null ? '' : String(model.maxTokens),
        input: model.input.length === 0 ? ['text'] : [...model.input],
        efforts,
        reasoning: declared === null || declared === undefined ? 'inherit' : declared === false ? 'false' : 'declare',
      };
    }),
  };
}

/** 草案 → 请求体。空串一律省略：后端把缺省当「未声明」，不是空值。 */
function payloadOf(draft: ProviderDraft): Record<string, unknown> {
  const models = draft.models.map(model => ({
    id: model.id.trim(),
    ...(model.name.trim() === '' ? {} : { name: model.name.trim() }),
    ...(model.contextWindow.trim() === '' ? {} : { contextWindow: Number(model.contextWindow) }),
    ...(model.maxTokens.trim() === '' ? {} : { maxTokens: Number(model.maxTokens) }),
    input: model.input,
    ...(model.reasoning === 'inherit' ? {} : model.reasoning === 'false' ? { reasoningEfforts: false } : {
      reasoningEfforts: Object.fromEntries(Object.entries(model.efforts).map(([level, wire]) => [level, wire === '' ? null : wire])),
    }),
  }));
  return {
    id: draft.id.trim(),
    ...(draft.displayName.trim() === '' ? {} : { displayName: draft.displayName.trim() }),
    api: draft.api,
    baseURL: draft.baseURL.trim(),
    ...(draft.apiKeyEnv.trim() === '' ? {} : { apiKeyEnv: draft.apiKeyEnv.trim() }),
    ...(draft.thinkingFormat === '' ? {} : { compat: { thinkingFormat: draft.thinkingFormat } }),
    models,
  };
}

function storedToken(): string {
  try { return window.localStorage.getItem(tokenStorageKey) ?? ''; } catch { return ''; }
}

async function send(path: string, init: RequestInit): Promise<{ ok: true; body: unknown } | { ok: false; status: number; error: string; errors: FieldError[] }> {
  const response = await fetch(path, init);
  const text = await response.text();
  let body: unknown = null;
  try { body = text === '' ? null : JSON.parse(text); } catch { body = null; }
  if (!response.ok) {
    const detail = (body ?? {}) as { error?: unknown; errors?: unknown };
    return {
      ok: false, status: response.status,
      error: typeof detail.error === 'string' ? detail.error : '请求失败（' + String(response.status) + '）。',
      errors: Array.isArray(detail.errors) ? (detail.errors as FieldError[]) : [],
    };
  }
  return { ok: true, body };
}

/** 就地字段错误：按字段前缀匹配。 */
function fieldError(errors: FieldError[], prefix: string): string {
  return errors.filter(entry => entry.field === prefix || entry.field.startsWith(prefix + '.')).map(entry => entry.message).join(' ');
}

export function ProviderPanel() {
  const [list, setList] = useState<ProviderList | null>(null);
  const [draft, setDraft] = useState<ProviderDraft>(emptyDraft());
  const [editing, setEditing] = useState<string | null>(null);
  const [benchToken, setBenchToken] = useState(storedToken());
  const [error, setError] = useState('');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [exported, setExported] = useState<{ profilePath: string; backupPath: string | null; content: string; written: boolean } | null>(null);

  const refresh = useCallback(async () => {
    const result = await send('/api/providers', { method: 'GET' });
    if (!result.ok) { setError(result.error); return; }
    setList(result.body as ProviderList);
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const authorized = async (path: string, init: RequestInit) => {
    const result = await send(path, { ...init, headers: { ...(init.headers ?? {}), 'content-type': 'application/json', 'x-bench-token': benchToken } });
    if (!result.ok && result.status === 401) {
      setBenchToken('');
      try { window.localStorage.removeItem(tokenStorageKey); } catch { /* 存储不可用时忽略。 */ }
    }
    return result;
  };

  const save = async () => {
    setBusy(true); setError(''); setErrors([]); setNotice('');
    try {
      const id = draft.id.trim();
      const result = await authorized('/api/providers/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify(payloadOf(draft)) });
      if (!result.ok) { setError(result.error); setErrors(result.errors); return; }
      setNotice('已保存到项目档案；作答与裁判会话会把它作为额外补丁层加载。');
      setEditing(id);
      await refresh();
    } finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await authorized('/api/providers/' + encodeURIComponent(id), { method: 'DELETE' });
      if (!result.ok) { setError(result.error); return; }
      setNotice('已从项目档案删除 ' + id + '。');
      setEditing(null); setDraft(emptyDraft());
      await refresh();
    } finally { setBusy(false); }
  };

  const runProbe = async () => {
    setBusy(true); setError(''); setErrors([]); setNotice(''); setProbe(null);
    try {
      const result = await authorized('/api/providers/probe', { method: 'POST', body: JSON.stringify({ baseURL: draft.baseURL.trim(), api: draft.api, apiKeyEnv: draft.apiKeyEnv.trim() }) });
      if (!result.ok) { setError(result.error); setErrors(result.errors); return; }
      const probed = result.body as ProbeResult;
      setProbe(probed);
      if (probed.models.length === 0) return;
      // 探测结果进模型列表供勾选/编辑：按 id 合并，已存在的保留用户手填的思考等级与模态。
      setDraft(current => {
        const existing = new Map(current.models.map(model => [model.id, model]));
        const adopted = probed.models.map(model => existing.get(model.id) ?? {
          ...emptyModel(model.id), name: model.name ?? '',
          contextWindow: model.contextWindow === undefined ? '' : String(model.contextWindow),
          maxTokens: model.maxTokens === undefined ? '' : String(model.maxTokens),
        });
        const handWritten = current.models.filter(model => model.id.trim() !== '' && !probed.models.some(entry => entry.id === model.id));
        return { ...current, models: [...adopted, ...handWritten] };
      });
    } finally { setBusy(false); }
  };

  const exportDsh = async (id: string, confirm: boolean) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await authorized('/api/providers/' + encodeURIComponent(id) + '/export-dsh', { method: 'POST', body: JSON.stringify({ confirm }) });
      if (!result.ok) { setError(result.error); return; }
      setExported(result.body as { profilePath: string; backupPath: string | null; content: string; written: boolean });
      setNotice(confirm ? '已写入 DSH 补丁层（原文件已备份）。' : '下面是将要写入的内容；确认前不会改动任何文件。');
    } finally { setBusy(false); }
  };

  const patchModel = (index: number, patch: Partial<ModelDraft>) => setDraft(current => ({
    ...current, models: current.models.map((model, at) => at === index ? { ...model, ...patch } : model),
  }));

  const select = (row: ProviderRow) => {
    setEditing(row.source === 'project' ? row.id : null);
    setDraft(draftOf(row));
    setProbe(null); setExported(null); setErrors([]); setError('');
  };

  const project = list?.providers.filter(row => row.source === 'project') ?? [];
  const patchRows = list?.providers.filter(row => row.source === 'dsh-patch') ?? [];

  return <section className="provider-section">
    <section className="section-head"><h2>供应商 <small>{project.length} 个项目档案</small></h2><span>端点、协议、模型、思考等级与输入模态</span></section>
    <p className="provider-hint">档案写进本项目自己的文件 <code>{list?.storePath ?? 'data/provider-profiles.json'}</code>，不改动 DSH 配置。密钥只按<strong>引用名</strong>声明：这里只显示「已配置 / 未配置」，不读取也不回显密钥值。</p>
    {error !== '' && <div className="error provider-error" role="alert">{error}</div>}
    {notice !== '' && <div className="warn provider-notice"><p>{notice}</p></div>}

    <div className="provider-token">
      <label htmlFor="provider-token">访问令牌</label>
      <input id="provider-token" type="password" autoComplete="off" value={benchToken} placeholder="与「配置」页签同一个 x-bench-token" onChange={event => setBenchToken(event.target.value)} />
      <span>只存在浏览器本地；保存、删除、探测与导出都要它。</span>
    </div>

    <div className="provider-layout">
      <aside className="provider-list" aria-label="供应商列表">
        {list === null ? <p className="empty">正在读取档案…</p> : <>
          {project.length === 0 && patchRows.length === 0 && <p className="empty">还没有供应商。用右侧表单新建一个。</p>}
          {project.map(row => <button key={row.id} className={editing === row.id ? 'provider-list-item selected' : 'provider-list-item'} onClick={() => select(row)}>
            <b>{row.id}</b><span>{row.displayName ?? row.id}</span>
            <small>{row.models.length} 个模型 · {row.keyConfigured ? '凭据已配置' : '凭据未配置'}</small>
          </button>)}
          {patchRows.length > 0 && <div className="provider-list-group">来自 DSH 配置（只读）</div>}
          {patchRows.map(row => <button key={row.id} className="provider-list-item provider-list-item-readonly" onClick={() => select(row)}>
            <b>{row.id}</b><span>{row.displayName ?? row.id}</span>
            <small>{row.models.length} 个模型 · DSH 补丁层</small>
          </button>)}
        </>}
        <button className="provider-new" onClick={() => { setEditing(null); setDraft(emptyDraft()); setProbe(null); setExported(null); setErrors([]); setError(''); }}>＋ 新建供应商</button>
      </aside>

      <article className="provider-form">
        <div className="provider-form-head">
          <h3>{editing === null ? '新建供应商' : '编辑 ' + editing}</h3>
          <span className="provider-source">{editing === null ? '将写入项目档案' : '来源：项目档案'}</span>
        </div>

        <div className="provider-grid">
          <label>供应商 ID <input value={draft.id} disabled={editing !== null} placeholder="gateway-a" onChange={event => setDraft({ ...draft, id: event.target.value })} />{fieldError(errors, 'id') !== '' && <em className="provider-field-error">{fieldError(errors, 'id')}</em>}</label>
          <label>显示名 <input value={draft.displayName} placeholder="项目网关" onChange={event => setDraft({ ...draft, displayName: event.target.value })} />{fieldError(errors, 'displayName') !== '' && <em className="provider-field-error">{fieldError(errors, 'displayName')}</em>}</label>
          <label>协议 <select value={draft.api} onChange={event => setDraft({ ...draft, api: event.target.value })}>{apiChoices.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>{fieldError(errors, 'api') !== '' && <em className="provider-field-error">{fieldError(errors, 'api')}</em>}</label>
          <label>端点 baseURL <input value={draft.baseURL} placeholder="https://gateway.example/v1" onChange={event => setDraft({ ...draft, baseURL: event.target.value })} />{fieldError(errors, 'baseURL') !== '' && <em className="provider-field-error">{fieldError(errors, 'baseURL')}</em>}</label>
          <label>凭据引用名 <input value={draft.apiKeyEnv} placeholder="ACME_GATEWAY_API_KEY（不要填密钥本身）" onChange={event => setDraft({ ...draft, apiKeyEnv: event.target.value })} />{fieldError(errors, 'apiKeyEnv') !== '' && <em className="provider-field-error">{fieldError(errors, 'apiKeyEnv')}</em>}</label>
          <label>思考方言（可选） <select value={draft.thinkingFormat} onChange={event => setDraft({ ...draft, thinkingFormat: event.target.value })}><option value="">不声明</option>{thinkingFormats.map(format => <option key={format} value={format}>{format}</option>)}</select>{fieldError(errors, 'compat') !== '' && <em className="provider-field-error">{fieldError(errors, 'compat')}</em>}</label>
        </div>

        <div className="provider-probe-bar">
          <button className="secondary" disabled={busy || draft.baseURL.trim() === ''} onClick={() => void runProbe()}>{busy ? '正在探测…' : '获取模型'}</button>
          {probe !== null && <span className={probe.protocol === 'listable' ? 'provider-probe-result' : 'provider-probe-result provider-probe-result-warn'}>{probe.note}</span>}
        </div>

        <section className="provider-models">
          <div className="section-head"><h4>模型 <small>{draft.models.length} 个</small></h4><button className="secondary" onClick={() => setDraft({ ...draft, models: [...draft.models, emptyModel()] })}>＋ 添加模型</button></div>
          {fieldError(errors, 'models') !== '' && <em className="provider-field-error">{fieldError(errors, 'models')}</em>}
          {draft.models.map((model, index) => <div className="provider-model-row" key={String(index)}>
            <div className="provider-grid provider-model-head">
              <label>模型 ID <input value={model.id} onChange={event => patchModel(index, { id: event.target.value })} />{fieldError(errors, 'models[' + String(index) + '].id') !== '' && <em className="provider-field-error">{fieldError(errors, 'models[' + String(index) + '].id')}</em>}</label>
              <label>显示名 <input value={model.name} onChange={event => patchModel(index, { name: event.target.value })} /></label>
              <label>上下文窗口 <input inputMode="numeric" value={model.contextWindow} placeholder="131072" onChange={event => patchModel(index, { contextWindow: event.target.value })} />{fieldError(errors, 'models[' + String(index) + '].contextWindow') !== '' && <em className="provider-field-error">{fieldError(errors, 'models[' + String(index) + '].contextWindow')}</em>}</label>
              <label>输出上限 <input inputMode="numeric" value={model.maxTokens} placeholder="8192" onChange={event => patchModel(index, { maxTokens: event.target.value })} />{fieldError(errors, 'models[' + String(index) + '].maxTokens') !== '' && <em className="provider-field-error">{fieldError(errors, 'models[' + String(index) + '].maxTokens')}</em>}</label>
            </div>
            <div className="provider-modalities">
              <span>输入模态</span>
              {modalities.map(([value, label]) => <label key={value} className="provider-check"><input type="checkbox" checked={model.input.includes(value)} onChange={event => patchModel(index, { input: event.target.checked ? [...model.input, value] : model.input.filter(item => item !== value) })} /> {label}</label>)}
              {fieldError(errors, 'models[' + String(index) + '].input') !== '' && <em className="provider-field-error">{fieldError(errors, 'models[' + String(index) + '].input')}</em>}
            </div>
            <div className="provider-efforts">
              <span>思考等级</span>
              <select value={model.reasoning} onChange={event => patchModel(index, { reasoning: event.target.value as ModelDraft['reasoning'] })}>
                <option value="inherit">沿用目录能力（不声明）</option>
                <option value="false">不支持推理</option>
                <option value="declare">声明等级表</option>
              </select>
              {model.reasoning === 'declare' && <div className="provider-effort-table">
                {thinkingLevels.map(level => <label key={level} className="provider-effort-row">
                  <span className="provider-check"><input type="checkbox" checked={Object.hasOwn(model.efforts, level)} onChange={event => {
                    const efforts = { ...model.efforts };
                    if (event.target.checked) efforts[level] = '';
                    else delete efforts[level];
                    patchModel(index, { efforts });
                  }} /> {level}</span>
                  <input value={model.efforts[level] ?? ''} disabled={!Object.hasOwn(model.efforts, level)} placeholder={level === 'off' ? '留空 = 不发参数' : '发给端点的拼写'} onChange={event => patchModel(index, { efforts: { ...model.efforts, [level]: event.target.value } })} />
                </label>)}
                {fieldError(errors, 'models[' + String(index) + '].reasoningEfforts') !== '' && <em className="provider-field-error">{fieldError(errors, 'models[' + String(index) + '].reasoningEfforts')}</em>}
              </div>}
            </div>
            <div className="provider-model-actions"><button className="secondary" disabled={draft.models.length <= 1} onClick={() => setDraft({ ...draft, models: draft.models.filter((_, at) => at !== index) })}>移除该模型</button></div>
          </div>)}
        </section>

        <div className="provider-actions">
          <button className="primary" disabled={busy || draft.id.trim() === ''} onClick={() => void save()}>{busy ? '正在保存…' : '保存供应商'}</button>
          {editing !== null && <button className="secondary" disabled={busy} onClick={() => void remove(editing)}>删除供应商</button>}
          {editing !== null && <button className="secondary" disabled={busy} onClick={() => void exportDsh(editing, false)}>生成 DSH 片段（不写入）</button>}
        </div>

        {exported !== null && <div className="provider-export">
          <h4>{exported.written ? '已写入 DSH 补丁层' : '将要写入 DSH 补丁层的内容'}</h4>
          <p>目标 <code>{exported.profilePath}</code>{exported.backupPath === null ? '' : '；原文件已备份为 ' + exported.backupPath}。这是覆盖式的：它按固定行 id 整块替换同 id 的配置。</p>
          <pre>{exported.content}</pre>
          {!exported.written && <button className="primary" disabled={busy} onClick={() => void exportDsh(editing!, true)}>确认写入（先备份）</button>}
        </div>}

        <details className="provider-sources"><summary>读取结论</summary><p>{list?.sources.project ?? ''}</p><p>{list?.sources.dshPatch ?? ''}</p><p>DSH profile 补丁层：<code>{list?.dshProfilePath ?? ''}</code></p></details>
      </article>
    </div>
  </section>;
}
