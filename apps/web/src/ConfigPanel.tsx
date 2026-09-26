import { useCallback, useEffect, useMemo, useState } from 'react';

/** 令牌只存在浏览器本地：所有写请求带 x-bench-token；401 时清空缓存并要求重新输入。 */
const tokenStorageKey = 'fsa.bench-token';

interface ConfigEntry {
  key: string;
  source: 'file' | 'environment';
  shadowed: boolean;
  writable: boolean;
  readOnlyReason: string | null;
  value?: string;
  configured?: boolean;
}
interface ConfigView {
  path: string;
  entries: Record<string, ConfigEntry>;
  writableKeys: string[];
  order: string[];
}
interface CatalogModel { id: string; name: string; reasoningEfforts: string[] }
interface CatalogProvider { id: string; name: string; models: CatalogModel[] }
interface CatalogPreset { id: string; name: string | null; order: number; source: { kind: string; file: string } }
interface Catalog { providers: CatalogProvider[]; warning: string; presets?: CatalogPreset[]; presetsWarning?: string }
interface PlanField { field: string; value: string }
interface PlanSecret { field: string; text: string }
interface PendingPlan { fields: PlanField[]; secrets: PlanSecret[] }

const manualChoice = '__manual__';
/** 探测不到本地 DSH 预设时的回退清单（离线、未装 DSH 时页面仍然可用）。 */
const fallbackPresets = [['standard', '标准'], ['ptc', 'PTC'], ['minimal', '极简'], ['cordis', '创造']] as const;
const presetLabels: Record<string, string> = Object.fromEntries(fallbackPresets);
const permissions = [
  ['read-only', '只读（禁止修改工作区）'],
  ['workspace-write', '工作区可写（仅当前题目目录）'],
  ['danger-full-access', '完整访问（DSH 不限制文件修改）'],
] as const;

type FieldKind = 'provider' | 'model' | 'effort' | 'preset' | 'permission' | 'text' | 'integer' | 'toggle' | 'secret';

interface FieldSpec { key: string; label: string; kind: FieldKind; hint?: string; providerKey?: string; fallback?: string }

/**
 * 三组可编排字段。顺序即页面顺序；每一项都对应 apps/api/src/config.ts 白名单里的一个键。
 * 只读项不在这里：它们从视图的 writable: false 条目渲染。
 */
const groups: Array<{ title: string; caption: string; fields: FieldSpec[] }> = [
  {
    title: '作答',
    caption: '决定 DSH 用哪个供应商、模型、模式与工作区权限作答；保存后新任务立即生效。',
    fields: [
      { key: 'BENCH_DSH_PROVIDER', label: '供应商', kind: 'provider', hint: '同名模型按供应商区分；目录不可用时手工填写。' },
      { key: 'BENCH_DSH_MODEL', label: '模型', kind: 'model', providerKey: 'BENCH_DSH_PROVIDER', hint: '选项来自本地 DSH 目录，不校验凭据与额度。' },
      { key: 'BENCH_DSH_PRESETS', label: '预设', kind: 'preset', fallback: 'standard', hint: '多选请用逗号分隔后手工填写。' },
      { key: 'BENCH_DSH_REASONING_EFFORT', label: '思考等级', kind: 'effort', providerKey: 'BENCH_DSH_PROVIDER', fallback: 'default', hint: 'default 表示不传参数，沿用供应商默认。' },
      { key: 'BENCH_DSH_WORKSPACE_PERMISSION', label: '工作区权限', kind: 'permission', fallback: 'workspace-write', hint: '会写入实验记录；完整访问会取消 DSH 文件沙箱限制。' },
    ],
  },
  {
    title: '裁判',
    caption: '独立评分 Agent 的模型与预算；未配置时质量分保持待定，不会用假设分补齐。',
    fields: [
      { key: 'BENCH_JUDGE_DSH_PROVIDER', label: '裁判供应商', kind: 'provider', hint: '与作答供应商相互独立。' },
      { key: 'BENCH_JUDGE_DSH_MODEL', label: '裁判模型', kind: 'model', providerKey: 'BENCH_JUDGE_DSH_PROVIDER' },
      { key: 'BENCH_JUDGE_DSH_REASONING_EFFORT', label: '裁判思考等级', kind: 'effort', providerKey: 'BENCH_JUDGE_DSH_PROVIDER', fallback: 'default', hint: '两轮会话使用同一等级。' },
      { key: 'BENCH_JUDGE_DSH_MAX_TOKENS', label: '每轮输出上限', kind: 'integer', fallback: '16384', hint: '含思考的 Token 上限，正整数。' },
      { key: 'BENCH_JUDGE_DSH_TIMEOUT_MS', label: '单轮超时（毫秒）', kind: 'integer', fallback: '300000', hint: '不能超过一小时（3600000）。' },
      { key: 'BENCH_JUDGE_PROMPT_VERSION', label: '提示版本', kind: 'text', fallback: 'dsh-review-v1', hint: '改动提示词时才需要新版本号。' },
      { key: 'BENCH_JUDGE_TOKEN', label: '裁判令牌', kind: 'secret', hint: '保存后不再回显；留空表示不修改。' },
    ],
  },
  {
    title: '目录与预算',
    caption: '报告根决定报告中心读哪里；提交目录决定正式提交入口是否可用。',
    fields: [
      { key: 'BENCH_DSH_REPORT_DIR', label: '报告根', kind: 'text', hint: '报告中心列出该目录下一层的实验报告。' },
      { key: 'BENCH_SUBMISSIONS_DIR', label: '提交目录', kind: 'text', hint: '正式提交只接受该目录内的候选；未配置时入口保持关闭。' },
      { key: 'BENCH_MEASURE_PERFORMANCE', label: '性能测量', kind: 'toggle', fallback: '0', hint: '开启后追加真实参考/候选性能采样；关闭时性能分保持缺失。' },
    ],
  },
];

export function ConfigPanel() {
  const [token, setToken] = useState('');
  const [view, setView] = useState<ConfigView | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [manual, setManual] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<PendingPlan | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setToken(window.localStorage.getItem(tokenStorageKey) ?? ''); }, []);

  const remember = useCallback((value: string) => {
    setToken(value);
    // 401 与手动清空都走这里：缓存与内存同时清掉，不会留下过期令牌。
    if (value.trim() === '') window.localStorage.removeItem(tokenStorageKey);
    else window.localStorage.setItem(tokenStorageKey, value);
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const [configResponse, catalogResponse] = await Promise.all([
        fetch('/api/config', signal ? { signal } : {}),
        fetch('/api/config/models', signal ? { signal } : {}),
      ]);
      if (!configResponse.ok) throw new Error(`配置读取失败（${configResponse.status}）。`);
      setView(await configResponse.json() as ConfigView);
      if (catalogResponse.ok) setCatalog(await catalogResponse.json() as Catalog);
      else setCatalog({ providers: [], warning: '本地 DSH 模型目录不可用；请手工填写供应商 ID 和模型 ID。' });
      setError('');
    } catch (cause) {
      if (signal?.aborted) return;
      setError(cause instanceof Error ? cause.message : '配置读取失败。');
    } finally { if (!signal?.aborted) setLoading(false); }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const entryOf = (key: string): ConfigEntry | undefined => view?.entries[key];
  const valueOf = (key: string, fallback = ''): string => edits[key] ?? entryOf(key)?.value ?? fallback;
  const edit = (key: string, value: string): void => { setEdits(current => ({ ...current, [key]: value })); setFieldErrors(current => { const { [key]: _removed, ...rest } = current; void _removed; return rest; }); setNotice(''); };

  const providers = useMemo(() => catalog?.providers ?? [], [catalog]);
  // 预设来自本地 DSH 探测；探测不到时回退到内置清单，页面保持可用。
  const presetCatalog = useMemo(() => (catalog?.presets ?? []).map(preset => ({ id: preset.id, label: preset.name ?? presetLabels[preset.id] ?? preset.id })), [catalog]);
  const presetOptions = presetCatalog.length > 0 ? presetCatalog : fallbackPresets.map(([id, label]) => ({ id, label }));
  const providerById = (id: string | undefined): CatalogProvider | undefined => providers.find(provider => provider.id === id);

  /** 保存：先取待写清单（密钥只显示「已填写」），确认后再真正写入。 */
  async function post(patch: Record<string, string>, confirm: boolean): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch('/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bench-token': token },
      body: JSON.stringify({ patch, confirm }),
    });
    const body = await response.json() as Record<string, unknown>;
    if (response.status === 401) { remember(''); throw new Error('令牌无效或已失效，请重新输入 x-bench-token。'); }
    return { status: response.status, body };
  }

  function collectErrors(body: Record<string, unknown>): Record<string, string> {
    const list = Array.isArray(body.errors) ? body.errors as Array<{ field?: unknown; message?: unknown }> : [];
    return Object.fromEntries(list.map(item => [String(item.field ?? ''), String(item.message ?? '校验失败。')]));
  }

  async function requestPlan() {
    const patch = { ...edits };
    if (Object.keys(patch).length === 0) { setError('没有需要保存的改动。'); return; }
    setBusy(true); setError(''); setNotice(''); setFieldErrors({});
    try {
      const { status, body } = await post(patch, false);
      if (status === 400) { setFieldErrors(collectErrors(body)); throw new Error(String(body.error ?? '配置未通过校验。')); }
      if (status !== 200) throw new Error(String(body.error ?? `保存失败（${status}）。`));
      setPending(body.plan as PendingPlan);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败。'); }
    finally { setBusy(false); }
  }

  async function confirmSave() {
    const patch = { ...edits };
    setBusy(true); setError('');
    try {
      const { status, body } = await post(patch, true);
      if (status === 409) throw new Error(String(body.error ?? '配置已被其它操作更改，请重新读取后再试。'));
      if (status === 400) { setFieldErrors(collectErrors(body)); throw new Error(String(body.error ?? '配置未通过校验。')); }
      if (status !== 200) throw new Error(String(body.error ?? `保存失败（${status}）。`));
      setView(body.view as ConfigView);
      setPending(null);
      setEdits({});
      setManual({});
      setNotice('已写入 ' + String((body.changedKeys as string[] | undefined)?.join('、') ?? '') + '；新配置已对本进程生效，无需重启。');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败。'); }
    finally { setBusy(false); }
  }

  function renderField(spec: FieldSpec) {
    const entry = entryOf(spec.key);
    // 视图缺失时仍然渲染，让操作者能看到该字段存在；写请求仍由服务端白名单校验。
    const writable = entry?.writable ?? true;
    const current = valueOf(spec.key, spec.fallback);
    const provider = providerById(spec.providerKey === undefined ? undefined : valueOf(spec.providerKey));
    const model = provider?.models.find(item => item.id === valueOf(spec.key));
    const options: string[] = spec.kind === 'provider' ? providers.map(item => item.id)
      : spec.kind === 'model' ? (provider?.models ?? []).map(item => item.id)
      : spec.kind === 'effort' ? [...new Set(['default', ...(model?.reasoningEfforts ?? [])])]
      : spec.kind === 'preset' ? presetOptions.map(option => option.id)
      : spec.kind === 'permission' ? permissions.map(([id]) => id)
      : [];
    const labelOf = (id: string): string => {
      if (spec.kind === 'provider') return providers.find(item => item.id === id)?.name ?? id;
      if (spec.kind === 'model') return provider?.models.find(item => item.id === id)?.name ?? id;
      if (spec.kind === 'preset') return presetOptions.find(option => option.id === id)?.label ?? id;
      if (spec.kind === 'permission') return permissions.find(([value]) => value === id)?.[1] ?? id;
      return id;
    };
    const listId = `config-${spec.key}`;
    // 已配置的值不在目录里（目录不可用或手工填写过）时直接给输入框，避免下拉框把真实值藏起来。
    const notInList = current.trim() !== '' && options.length > 0 && !options.includes(current);
    const manualMode = manual[spec.key] === true || notInList;
    const useSelect = spec.kind !== 'text' && spec.kind !== 'integer' && spec.kind !== 'toggle' && spec.kind !== 'secret' && options.length > 0 && !manualMode;
    return <div className="field" key={spec.key}>
      <div className="field-head">
        <label htmlFor={listId}>{spec.label}</label>
        <code>{spec.key}</code>
        {entry?.shadowed === true && <span className="state-tag warn" title=".env 中的值被非空的系统环境变量覆盖，保存后仍然由环境变量生效。">被系统环境变量覆盖</span>}
        {entry && entry.writable === false && <span className="state-tag idle">只读</span>}
        {edits[spec.key] !== undefined && <span className="state-tag ok">已修改</span>}
      </div>
      {spec.kind === 'secret'
        ? <input id={listId} type="password" autoComplete="off" disabled={!writable} value={edits[spec.key] ?? ''}
            placeholder={entry?.configured === true ? '已填写（留空表示不修改）' : '未填写'} onChange={event => edit(spec.key, event.target.value)} />
        : spec.kind === 'toggle'
          ? <select id={listId} disabled={!writable} value={current === '1' ? '1' : '0'} onChange={event => edit(spec.key, event.target.value)}>
              <option value="0">关闭</option><option value="1">开启</option>
            </select>
          : useSelect
            ? <select id={listId} disabled={!writable} value={current} onChange={event => {
                if (event.target.value === manualChoice) setManual(value => ({ ...value, [spec.key]: true }));
                else edit(spec.key, event.target.value);
              }}>
                <option value="">（未设置）</option>
                {options.map(id => <option key={id} value={id}>{labelOf(id)}{id === 'default' ? '（沿用供应商默认）' : ''}</option>)}
                <option value={manualChoice}>手工填写…</option>
              </select>
            : <div className="field-input">
                <input id={listId} disabled={!writable} value={edits[spec.key] ?? current} inputMode={spec.kind === 'integer' ? 'numeric' : undefined} onChange={event => edit(spec.key, event.target.value)} />
                {spec.kind !== 'integer' && options.length > 0 && manualMode && <button type="button" className="link" onClick={() => { setManual(value => ({ ...value, [spec.key]: false })); edit(spec.key, options[0]!); }}>从列表选择</button>}
              </div>}
      {spec.hint !== undefined && <p className="field-hint">{spec.hint}</p>}
      {fieldErrors[spec.key] !== undefined && <p className="field-error">{fieldErrors[spec.key]}</p>}
      {entry?.shadowed === true && <p className="field-hint">当前生效值来自操作系统环境变量；保存 .env 后仍被系统环境变量覆盖，需要先清除该环境变量才会读到 .env 的值。</p>}
      {entry?.writable === false && <p className="field-hint">{entry.readOnlyReason}</p>}
    </div>;
  }

  const readOnlyEntries = (view?.order ?? []).map(key => view?.entries[key]).filter((entry): entry is ConfigEntry => entry !== undefined && !entry.writable);

  return <section>
    <div className="section-head"><h2>配置 <small>{Object.keys(edits).length} 项待保存</small></h2><button className="secondary" disabled={loading} onClick={() => void load()}>重新读取</button></div>
    <p>修改运行配置并写入项目 .env。保存只覆写本次编辑过的字段，其余键、注释与未知字段保持原样；保存后本进程立即按新值工作，无需重启 API。</p>
    <div className="token-bar">
      <label htmlFor="config-token">访问令牌 x-bench-token</label>
      <input id="config-token" type="password" autoComplete="off" value={token} placeholder="与 .env 的 BENCH_RUN_TOKEN 一致" onChange={event => remember(event.target.value)} />
      <span>{token.trim() === '' ? '未填写：写操作会被拒绝（401）' : '已保存在此浏览器本地'}</span>
      <button type="button" className="secondary" onClick={() => remember('')}>清除</button>
    </div>
    {view && <p className="experiment-path">配置文件：{view.path}</p>}
    {error && <div className="error" role="alert">{error} <button onClick={() => void load()}>重新读取</button></div>}
    {notice && <div className="notice" role="status"><b>已保存</b><span>{notice}</span></div>}
    {loading ? <div className="empty" role="status">正在读取配置…</div> : !view ? <div className="empty">配置不可用。</div> : <>
      {catalog?.warning !== undefined && <p className="field-hint">{catalog.warning}</p>}
      {catalog !== null && <p className="field-hint">预设：{presetCatalog.length > 0
        ? (catalog.presetsWarning ?? '预设来自本地 DSH 声明式 YAML；列表不验证该预设能否在本机装载。')
        : '未探测到本地 DSH 预设，已回退到内置的 standard、ptc、minimal、cordis。'}</p>}
      <div className="config-grid">{groups.map(group => <article className="detail config-group" key={group.title}>
        <h3>{group.title}</h3><p>{group.caption}</p>
        {group.fields.map(renderField)}
      </article>)}</div>
      <article className="detail config-group">
        <h3>只读项 <small>需要到 CLI 修改</small></h3>
        <p>这些配置决定既有记录的物理位置或进程级执行链路，网页不可编排；请用 CLI 或环境变量修改后重启服务。</p>
        <div className="meta-grid">{readOnlyEntries.map(entry => <div key={entry.key}>
          <span>{entry.key}{entry.shadowed && ' · 被系统环境变量覆盖'}</span>
          <b>{entry.value === undefined ? (entry.configured === true ? '已填写' : '未填写') : entry.value === '' ? '（未设置）' : entry.value}</b>
          <small className="field-hint">{entry.readOnlyReason}</small>
        </div>)}</div>
      </article>
      <div className="report-actions">
        <button className="primary" disabled={busy || Object.keys(edits).length === 0} onClick={() => void requestPlan()}>{busy ? '正在校验…' : `保存 ${Object.keys(edits).length} 项改动`}</button>
        <button className="secondary" disabled={busy || Object.keys(edits).length === 0} onClick={() => { setEdits({}); setManual({}); setFieldErrors({}); setNotice(''); }}>放弃改动</button>
      </div>
    </>}
    {pending && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="确认写入配置">
      <div className="modal">
        <h3>确认写入 {view?.path}</h3>
        <p>以下字段将被写入 .env 并立即生效；其余字段、注释与未知键保持原样。密钥只显示是否已填写，不回显值。</p>
        <div className="checks-table"><table><thead><tr><th>键</th><th>将写入</th></tr></thead><tbody>
          {pending.fields.map(item => <tr key={item.field}><td><code>{item.field}</code></td><td>{item.value}</td></tr>)}
          {pending.secrets.map(item => <tr key={item.field}><td><code>{item.field}</code></td><td>{item.text}（新值不会回显）</td></tr>)}
        </tbody></table></div>
        {pending.fields.some(item => entryOf(item.field)?.shadowed === true) && <div className="warn"><b>遮蔽警告</b><p>有字段在 .env 中已有值，但当前被非空的系统环境变量覆盖：保存后仍被系统环境变量覆盖，实际生效的仍是环境变量的值。</p><ul>{pending.fields.filter(item => entryOf(item.field)?.shadowed === true).map(item => <li key={item.field}><code>{item.field}</code></li>)}</ul></div>}
        <div className="report-actions">
          <button className="primary" disabled={busy} onClick={() => void confirmSave()}>{busy ? '正在写入…' : '确认写入'}</button>
          <button className="secondary" disabled={busy} onClick={() => setPending(null)}>取消</button>
        </div>
      </div>
    </div>}
  </section>;
}
