import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { experimentDetailValidator, experimentListValidator, type ExperimentDetail, type ExperimentRow, type Task } from '@fsa/contracts';

/**
 * 发起测评：把「发起自动测评 / 实时看进度 / 可靠取消」与「提交外部作答」放进一个页签。
 *
 * 页面只与三个 API 打交道：
 * - POST/GET /api/experiments 与 POST /api/experiments/:launchId/cancel（启动、纯读进度、取消）；
 * - POST/GET /api/submissions（外部作答候选与提交，提交复用既有运行入口）；
 * - GET /api/reports（进行中的实验读 experiment.json，逐行阶段与进度日志沿用报告中心的展示）。
 *
 * 展示语义由服务端的 mergeState 决定：页面只显示它给出的结论与残留三态，不自行推断「已完成」「已终止」。
 */

/** 与 ConfigPanel 共用同一个浏览器本地键：两处写入的都是 x-bench-token。 */
const tokenStorageKey = 'fsa.bench-token';

/** 探测不到本地 DSH 预设时的回退清单（离线、未装 DSH 时页面仍然可用）。 */
const fallbackPresets = [['standard', '标准'], ['ptc', 'PTC'], ['minimal', '极简'], ['cordis', '创造']] as const;
/** 内置标签只按 id 兜底展示；探测到的预设不带展示名时用它，未知 id 直接显示 id。 */
const presetLabels: Record<string, string> = Object.fromEntries(fallbackPresets);
const defaultModes = ['default', 'off', 'low', 'medium', 'high', 'max'];
const difficultyLabels: Record<string, string> = { easy: '简单', medium: '中等', hard: '困难', extreme: '极度困难' };
const reasonOptions = [['agent-completed', '外部 Agent 已完成'], ['operator-submit', '操作者提交'], ['patch-import', '补丁导入']] as const;
const phaseLabels: Record<ExperimentRow['phase'], string> = {
  pending: '待作答', solving: '作答中', grading: '验证评分中', done: '已完成', 'solver-stopped': '作答中止', error: '出错',
};
const phaseClass = (phase: ExperimentRow['phase']) => phase === 'solver-stopped' ? 'stopped' : phase;
const time = (value: string | null) => value === null || value === '' ? '未登记' : new Date(value).toLocaleString('zh-CN');

interface LaunchPlan {
  taskIds: string[]; presets: string[]; modes: string[]; repeats: number; timeoutMinutes: number; maxTokens: number;
  measurePerformance: boolean; provider: string; model: string; answers: number;
}
interface MergedState { process: string; verdict: string; text: string; cleanup: string; cleanupText: string; cleanupUncertain: boolean; exitOk: boolean | null }
interface ResidueView { status: 'none' | 'unknown' | 'present'; detail: string; pids: number[] }
interface LaunchView {
  launchId: string; kind: string; experimentId: string; outputRoot: string; startedAt: string; state: string; exitCode: number | null;
  logPath: string; plan: LaunchPlan; args: string[];
  pid: number | null; pidStartedAt: string | null; ownership: string;
  childPid: number | null; childOwnership: string; heartbeatAt: string | null; leaseExpired: boolean; note: string | null;
  readable: boolean; error: string | null;
  exit: { code: number | null; signal: string | null; at: string; descendantsVerified: boolean; note: string | null; cancelled: boolean } | null;
  merged: MergedState; residue: ResidueView;
  descendants: Array<{ pid: number; startedAt: string | null; role: string; ownership: string }>;
  experiment: { directory: string; exists: boolean; state: string | null; cleanup: string | null };
  cancelRequested: boolean;
}
interface CancelOutcome { action: string; confirmedExit: boolean; text: string; residue: ResidueView; targets: number[] }
interface Candidate { name: string; directory: string; files: number; modifiedAt: string }
interface CatalogModel { id: string; name: string; reasoningEfforts: string[] }
interface CatalogProvider { id: string; name: string; models: CatalogModel[] }
interface CatalogPreset { id: string; name: string | null; order: number; source: { kind: string; file: string } }
interface Catalog { providers: CatalogProvider[]; warning: string; presets?: CatalogPreset[]; presetsWarning?: string }

interface LaunchForm {
  scope: 'one' | 'all' | 'core' | 'difficulty' | 'manual';
  difficulty: string;
  taskIds: string[];
  provider: string;
  model: string;
  presets: string[];
  modes: string[];
  repeats: number;
  timeoutMinutes: number;
  maxTokens: number;
  concurrency: number;
  measurePerformance: boolean;
  outputRoot: string;
}

const initialForm: LaunchForm = {
  scope: 'one', difficulty: 'medium', taskIds: ['CACHE-02'], provider: '', model: '',
  presets: ['standard'], modes: ['off', 'high'], repeats: 1, timeoutMinutes: 20, maxTokens: 16384,
  concurrency: 1,
  measurePerformance: false, outputRoot: '',
};

/** 展示徽标的种类由服务端结论决定，不在这里发明新的状态词。 */
const verdictKind = (verdict: string): 'ok' | 'warn' | 'bad' | 'idle' =>
  verdict === 'running' || verdict === 'starting' ? 'ok' : verdict === 'completed' ? 'idle' : verdict === 'cancelled' || verdict === 'aborted' ? 'warn' : verdict === 'failed' || verdict === 'unknown' ? 'bad' : 'idle';
const verdictText: Record<string, string> = {
  starting: '正在启动', running: '进行中', completed: '已完成', failed: '失败', cancelled: '已取消', aborted: '已中止', unknown: '状态未知',
};
const residueKind = (status: string): 'ok' | 'warn' | 'bad' => status === 'none' ? 'ok' : status === 'present' ? 'bad' : 'warn';
const residueText: Record<string, string> = { none: '已确认无残留', unknown: '残留未知', present: '仍有残留' };

/**
 * 取消按钮为何不可用。以前只在无法取消时把按钮变灰，鼠标还显示「等待」光标，
 * 看起来像在加载——其实进程早已结束。这里把原因直接写在按钮旁，不再需要靠光标猜。
 */
function cancelDisabledReason(busy: boolean, process: string): string {
  if (busy) return '正在处理上一个请求，稍后可取消。';
  if (process === 'live') return '测评进行中，点击即终止整棵进程树。';
  if (process === 'unknown') return '进程状态未知：无法确认它是否仍在运行，因此不提供取消，避免误终止。';
  return '进程已结束，没有可终止的对象。已结束的测评不能取消。';
}

async function readError(response: Response): Promise<string> {
  try {
    const value: unknown = await response.json();
    if (typeof value === 'object' && value !== null && 'error' in value) return String((value as { error: unknown }).error);
  } catch { /* 响应不是 JSON，退回状态码说明 */ }
  return '请求失败（' + response.status + '）。';
}

export function LaunchPanel({ tasks }: { tasks: Task[] }) {
  const [token, setToken] = useState('');
  const [form, setForm] = useState<LaunchForm>(initialForm);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [launches, setLaunches] = useState<LaunchView[]>([]);
  const [selection, setSelection] = useState('');
  const [detail, setDetail] = useState<ExperimentDetail | null>(null);
  const [pending, setPending] = useState<{ answers: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [cancelResult, setCancelResult] = useState<{ launchId: string; outcome: CancelOutcome } | null>(null);
  // 清理启动记录：只对已落定的记录开放；进行中或状态未知的记录由服务端拒绝。
  const [pendingCleanup, setPendingCleanup] = useState<string | null>(null);
  const [cleanupResult, setCleanupResult] = useState<{ launchId: string; message: string; ok: boolean } | null>(null);

  /** 清理一条启动记录：账本 json、退出事实、日志与取消标记一并移入 <启动根>/.trash。 */
  async function cleanLaunch(launchId: string) {
    try {
      const response = await fetch('/api/experiments/' + encodeURIComponent(launchId), { method: 'DELETE', headers: authHeaders });
      const value: unknown = await response.json().catch(() => null);
      const detail = typeof value === 'object' && value !== null && 'error' in value ? String((value as { error: unknown }).error) : '';
      if (!response.ok) {
        setCleanupResult({ launchId, ok: false, message: response.status === 401 ? '令牌无效或已失效：' + (detail || '请检查运行令牌。') : '清理失败（' + response.status + '）：' + (detail || '服务端未给出原因。') });
        return;
      }
      const trash = typeof value === 'object' && value !== null && 'trashPath' in value ? String((value as { trashPath: unknown }).trashPath) : '';
      setCleanupResult({ launchId, ok: true, message: '已移入回收目录：' + trash + '。需要恢复就把里面的文件移回启动记录根。' });
      setPendingCleanup(null);
      setRevision(current => current + 1);
    } catch (cause) {
      setCleanupResult({ launchId, ok: false, message: '清理失败：' + (cause instanceof Error ? cause.message : '网络错误。') });
    }
  }
  const [candidates, setCandidates] = useState<{ root: string | null; candidates: Candidate[]; truncated: boolean; warning: string | null } | null>(null);
  const [submission, setSubmission] = useState({ candidateDirectory: '', taskId: 'CACHE-02', idempotencyKey: '', reason: 'agent-completed', measure: false });
  const [submissionResult, setSubmissionResult] = useState('');
  const [revision, setRevision] = useState(0);
  const live = useRef(false);

  useEffect(() => { setToken(window.localStorage.getItem(tokenStorageKey) ?? ''); }, []);
  const remember = useCallback((value: string) => {
    setToken(value);
    if (value.trim() === '') window.localStorage.removeItem(tokenStorageKey);
    else window.localStorage.setItem(tokenStorageKey, value);
  }, []);

  const headers = useMemo(() => ({ 'content-type': 'application/json', 'x-bench-token': token }), [token]);
  /**
   * 无请求体请求（DELETE）专用：**不能**带 content-type: application/json。
   * Fastify 见到该头却收到空体会以 400 FST_ERR_CTP_EMPTY_JSON_BODY 拒绝，
   * 清理请求根本到不了业务逻辑。
   */
  const authHeaders = useMemo(() => ({ 'x-bench-token': token }), [token]);

  // 仅在存在进行中的启动记录时轮询：已落定的记录不重复请求。
  useEffect(() => {
    const timer = setInterval(() => { if (live.current) setRevision(value => value + 1); }, 3000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      const [launchResponse, candidateResponse] = await Promise.all([
        fetch('/api/experiments', { signal: controller.signal }),
        fetch('/api/submissions', { signal: controller.signal }),
      ]);
      if (!launchResponse.ok) throw new Error('启动记录加载失败（' + launchResponse.status + '）。');
      const value = await launchResponse.json() as { launches: LaunchView[] };
      if (controller.signal.aborted) return;
      setLaunches(value.launches);
      live.current = value.launches.some(item => item.merged.process === 'live');
      if (candidateResponse.ok) setCandidates(await candidateResponse.json() as { root: string | null; candidates: Candidate[]; truncated: boolean; warning: string | null });
      else setCandidates({ root: null, candidates: [], truncated: false, warning: '提交候选读取失败（' + candidateResponse.status + '）。' });
      setError('');
    }
    void load().catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : '启动记录加载失败。');
    });
    return () => controller.abort();
  }, [revision]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/config/models', { signal: controller.signal })
      .then(response => response.ok ? response.json() as Promise<Catalog> : { providers: [], warning: '本地 DSH 模型目录不可用；登录供应商与模型需在配置页签保存。' })
      .then(value => { if (!controller.signal.aborted) setCatalog(value); })
      .catch(() => { if (!controller.signal.aborted) setCatalog({ providers: [], warning: '本地 DSH 模型目录不可用。' }); });
    return () => controller.abort();
  }, []);

  const current = launches.find(item => item.launchId === selection) ?? launches[0] ?? null;
  const currentId = current?.launchId ?? '';
  const shown = detail !== null && detail.directoryName === current?.experimentId ? detail : null;

  // 进行中的实验：从报告中心读同一份 experiment.json，逐行阶段与进度日志沿用它的展示。
  useEffect(() => {
    if (current === null || current.experiment.exists !== true) { setDetail(null); return; }
    const controller = new AbortController();
    void (async () => {
      try {
        const listResponse = await fetch('/api/reports', { signal: controller.signal });
        if (!listResponse.ok) return;
        const list: unknown = await listResponse.json();
        if (!experimentListValidator.Check(list)) return;
        const entry = list.find(item => item.directoryName === current.experimentId);
        if (entry === undefined || entry.status !== 'ok') return;
        const detailResponse = await fetch('/api/reports/' + encodeURIComponent(entry.reportId), { signal: controller.signal });
        const data: unknown = await detailResponse.json().catch(() => null);
        if (controller.signal.aborted || !detailResponse.ok) return;
        if (experimentDetailValidator.Check(data)) setDetail(data);
      } catch { /* 明细读不出来就只显示启动记录，不影响其余部分 */ }
    })();
    return () => controller.abort();
  }, [currentId, revision, current?.experiment.exists, current?.experimentId]);

  const providers = catalog?.providers ?? [];
  // 探测到的预设优先；顺序由服务端按声明顺序给出，展示名缺失时回退到内置中文标签。
  const presetOptions = (catalog?.presets ?? []).map(preset => ({ id: preset.id, label: preset.name ?? presetLabels[preset.id] ?? preset.id }));
  const presetsUsable = presetOptions.length > 0;
  const presetChoices = presetsUsable ? presetOptions : fallbackPresets.map(([id, label]) => ({ id, label }));
  const presetHint = presetsUsable
    ? catalog?.presetsWarning
    : (catalog === null ? '正在探测本地 DSH 预设…' : (catalog.presetsWarning ?? '未探测到本地 DSH 预设，已回退到内置的 standard、ptc、minimal、cordis。'));
  const models = providers.find(item => item.id === form.provider)?.models ?? [];
  const selectable = tasks.filter(task => task.status !== 'designed');
  const taskCount = form.scope === 'one' ? 1
    : form.scope === 'all' ? selectable.length
    : form.scope === 'core' ? selectable.filter(task => task.track === 'core').length
    : form.scope === 'difficulty' ? selectable.filter(task => task.difficulty === form.difficulty).length
    : form.taskIds.length;
  // 计划总作答次数：题数 × 预设数 × 等级数 × 重复次数。与 POST 返回的 plannedAnswers 必须一致。
  const answers = taskCount * form.presets.length * form.modes.length * Math.max(0, form.repeats);

  const edit = (patch: Partial<LaunchForm>): void => { setForm(current => ({ ...current, ...patch })); setNotice(''); setPending(null); };
  const toggle = (key: 'presets' | 'modes' | 'taskIds', value: string): void => {
    const values = form[key];
    edit({ [key]: values.includes(value) ? values.filter(item => item !== value) : [...values, value] } as Partial<LaunchForm>);
  };

  const payload = () => ({
    scope: form.scope, difficulty: form.difficulty,
    ...(form.scope === 'manual' ? { taskIds: form.taskIds } : {}),
    ...(form.provider.trim() === '' ? {} : { provider: form.provider.trim() }),
    ...(form.model.trim() === '' ? {} : { model: form.model.trim() }),
    presets: form.presets, modes: form.modes, repeats: form.repeats, timeoutMinutes: form.timeoutMinutes,
    maxTokens: form.maxTokens, measurePerformance: form.measurePerformance, concurrency: form.concurrency,
    ...(form.outputRoot.trim() === '' ? {} : { outputRoot: form.outputRoot.trim() }),
  });

  /** check=true 走「仅预检」：仍然冻结配置快照并起 supervisor，但子进程只做本地预检。 */
  async function submit(check: boolean) {
    setBusy(true);
    setError('');
    setNotice('');
    setPending(null);
    try {
      const response = await fetch('/api/experiments', { method: 'POST', headers, body: JSON.stringify({ ...payload(), check }) });
      if (response.status === 401) { remember(''); throw new Error('令牌无效或未配置；请在配置页签保存 BENCH_RUN_TOKEN 后再试。'); }
      if (!response.ok) throw new Error(await readError(response));
      const value = await response.json() as { plannedAnswers: number; launch: LaunchView };
      setNotice((check ? '已发起仅预检：' : '已发起真实作答：') + '计划 ' + value.plannedAnswers + ' 次作答；启动 ' + value.launch.launchId + '。' + value.launch.merged.text);
      setSelection(value.launch.launchId);
      setRevision(current => current + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '发起测评失败。'); }
    finally { setBusy(false); }
  }

  async function cancel(launchId: string) {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/experiments/' + encodeURIComponent(launchId) + '/cancel', { method: 'POST', headers });
      if (response.status === 401) { remember(''); throw new Error('取消需要有效令牌。'); }
      if (!response.ok) throw new Error(await readError(response));
      setCancelResult({ launchId, outcome: await response.json() as CancelOutcome });
      setRevision(current => current + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '取消失败。'); }
    finally { setBusy(false); }
  }

  async function submitExternal() {
    setBusy(true);
    setError('');
    setSubmissionResult('');
    try {
      const response = await fetch('/api/submissions', { method: 'POST', headers, body: JSON.stringify({
        taskId: submission.taskId, candidateDirectory: submission.candidateDirectory,
        idempotencyKey: submission.idempotencyKey, submittedBy: 'web-operator', reason: submission.reason, measure: submission.measure,
      }) });
      if (response.status === 401) { remember(''); throw new Error('提交需要有效令牌。'); }
      if (!response.ok) throw new Error(await readError(response));
      const value = await response.json() as { runId: string; attemptId: string; phase: string; classification: string | null };
      setSubmissionResult('已提交并完成可用验证：' + value.runId + '/' + value.attemptId + ' · 阶段 ' + value.phase + ' · 结论 ' + (value.classification ?? '未评分') + '。');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '提交失败。'); }
    finally { setBusy(false); }
  }

  const cancelText = cancelResult === null ? null : cancelResult.outcome;

  return <section>
    <div className="section-head"><h2>发起测评 <small>{launches.length} 条启动记录</small></h2>
      <button className="secondary" disabled={busy} aria-busy={busy} onClick={() => setRevision(value => value + 1)}>刷新</button></div>
    <p>发起后由受控 supervisor 持有实验子进程：API 只负责登记与对账，通过它的心跳与退出事实判断真实状态。默认按钮是「仅预检」，不调用模型；真实作答需要二次确认。</p>

    <div className="token-bar">
      <label htmlFor="launch-token">运行令牌</label>
      <input id="launch-token" type="password" value={token} placeholder="BENCH_RUN_TOKEN" onChange={event => remember(event.target.value)} />
      <span>与配置页签共用本地缓存；只写入请求头 x-bench-token，不回显、不外传。</span>
    </div>

    {error && <div className="error" role="alert">{error}</div>}
    {notice && <div className="notice-inline" role="status">{notice}</div>}

    <h3>测评参数</h3>
    <div className="launch-grid">
      <div className="launch-field">
        <label htmlFor="launch-scope">题目范围</label>
        <select id="launch-scope" value={form.scope} onChange={event => edit({ scope: event.target.value as LaunchForm['scope'] })}>
          <option value="one">试一题（CACHE-02）</option>
          <option value="all">全部已就绪题目（{selectable.length} 题）</option>
          <option value="core">核心题（{selectable.filter(task => task.track === 'core').length} 题）</option>
          <option value="difficulty">按难度</option>
          <option value="manual">手工多选</option>
        </select>
        {form.scope === 'difficulty' && <select aria-label="难度" value={form.difficulty} onChange={event => edit({ difficulty: event.target.value })}>
          {Object.entries(difficultyLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>}
        {form.scope === 'manual' && <div className="launch-checklist" aria-label="手工多选题目">
          {selectable.map(task => <label key={task.id}><input type="checkbox" checked={form.taskIds.includes(task.id)} onChange={() => toggle('taskIds', task.id)} /> {task.id}</label>)}
        </div>}
      </div>
      <div className="launch-field">
        <label htmlFor="launch-provider">供应商</label>
        <select id="launch-provider" value={form.provider} onChange={event => edit({ provider: event.target.value, model: '' })}>
          <option value="">沿用配置</option>
          {providers.map(item => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}
        </select>
        <label htmlFor="launch-model">模型</label>
        <select id="launch-model" value={form.model} onChange={event => edit({ model: event.target.value })} disabled={form.provider === ''}>
          <option value="">沿用配置</option>
          {models.map(item => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}
        </select>
        {catalog?.warning && <small>{catalog.warning}</small>}
      </div>
      <div className="launch-field">
        <span className="launch-label">DSH 预设</span>
        <div className="launch-checklist">{presetChoices.map(option => <label key={option.id}><input type="checkbox" checked={form.presets.includes(option.id)} onChange={() => toggle('presets', option.id)} /> {option.label}{option.label === option.id ? '' : '（' + option.id + '）'}</label>)}</div>
        {presetHint && <small>{presetHint}</small>}
        <span className="launch-label">思考等级</span>
        <div className="launch-checklist">{[...new Set([...defaultModes, ...(models.find(item => item.id === form.model)?.reasoningEfforts ?? [])])].map(value =>
          <label key={value}><input type="checkbox" checked={form.modes.includes(value)} onChange={() => toggle('modes', value)} /> {value}</label>)}</div>
      </div>
      <div className="launch-field">
        <label htmlFor="launch-repeats">重复次数（1–20）</label>
        <input id="launch-repeats" type="number" min={1} max={20} value={form.repeats} onChange={event => edit({ repeats: Number(event.target.value) })} />
        <label htmlFor="launch-minutes">每次限时（分钟）</label>
        <input id="launch-minutes" type="number" min={1} max={1440} value={form.timeoutMinutes} onChange={event => edit({ timeoutMinutes: Number(event.target.value) })} />
        <label htmlFor="launch-tokens">每次请求输出上限</label>
        <input id="launch-tokens" type="number" min={1} value={form.maxTokens} onChange={event => edit({ maxTokens: Number(event.target.value) })} />
        <label htmlFor="launch-concurrency">并行度（1–8）</label>
        <input id="launch-concurrency" type="number" min={1} max={8} value={form.concurrency}
          onChange={event => edit({ concurrency: Math.min(8, Math.max(1, Number(event.target.value) || 1)) })} />
        <small>1 = 串行。大于 1 时同时推进多道题：作答、容器验证与裁判评分重叠进行。
          实测 55 题串行约 259 分钟（作答 46%、验证与评分 54%），3 路可让两者不再互相等待。
          每题仍用独立 workspace、独立容器与独立裁判会话，结果与串行可比。</small>
      </div>
      <div className="launch-field">
        <label htmlFor="launch-output">报告根</label>
        <input id="launch-output" value={form.outputRoot} placeholder="留空沿用 BENCH_DSH_REPORT_DIR" onChange={event => edit({ outputRoot: event.target.value })} />
        <label className="launch-inline"><input type="checkbox" checked={form.measurePerformance} onChange={event => edit({ measurePerformance: event.target.checked })} /> 启用性能测量（关闭时性能分保持缺失）</label>
      </div>
    </div>

    <div className="launch-actions">
      <div className="planned-answers" role="status">计划总作答次数 <b>{answers}</b> 次 <small>= {taskCount} 题 × {form.presets.length} 预设 × {form.modes.length} 等级 × {form.repeats} 重复</small></div>
      <button className="primary" disabled={busy || answers === 0} aria-busy={busy} onClick={() => void submit(true)}>仅预检</button>
      <button className="secondary" disabled={busy || answers === 0} aria-busy={busy} onClick={() => setPending({ answers })}>发起真实作答…</button>
    </div>
    {pending !== null && <div className="warn" role="alert">
      <b>确认发起真实作答？</b>
      <p>本次会调用已配置的作答模型与裁判，计划 <b>{pending.answers}</b> 次作答（{taskCount} 题 × {form.presets.length} 预设 × {form.modes.length} 等级 × {form.repeats} 重复）。这会消耗真实额度。</p>
      <div className="launch-actions"><button className="primary" disabled={busy} aria-busy={busy} onClick={() => void submit(false)}>确认发起</button><button className="secondary" disabled={busy} onClick={() => setPending(null)}>取消</button></div>
    </div>}

    <h3>启动记录 <small>{launches.length} 条</small></h3>
    {launches.length === 0 ? <div className="empty"><h3>还没有启动记录</h3><p>用上面的表单发起一次「仅预检」，它不调用模型。</p></div>
      : <div className="report-layout">
        <aside className="report-list" aria-label="选择启动记录">{launches.map(item => {
          const kind = verdictKind(item.merged.verdict);
          return <button key={item.launchId} aria-pressed={item.launchId === currentId} className={'report-item experiment-item' + (item.launchId === currentId ? ' selected' : '')} onClick={() => setSelection(item.launchId)}>
            <b>{item.experimentId}</b><span className={'state-tag ' + kind}>{verdictText[item.merged.verdict] ?? item.merged.verdict}</span>
            <span>{item.kind === 'check' ? '仅预检' : '真实作答'} · {item.plan.answers} 次</span>
            <span>{time(item.startedAt)}</span>
          </button>;
        })}</aside>
        <article className="detail report-detail">
          {current === null ? <div className="empty">没有可展示的启动记录。</div> : <>
            <div className="detail-top"><h2>{current.experimentId}</h2><span className={'state-tag ' + verdictKind(current.merged.verdict)}>{verdictText[current.merged.verdict] ?? current.merged.verdict}</span></div>
            {!current.readable ? <div className="warn broken" role="alert"><b>启动记录不可读</b><p>{current.error ?? '原因未登记。'}</p></div> : <>
              <div className="meta-grid">
                <div><span>进程判定</span><b>{current.merged.process} · 记录 {current.state}</b></div>
                <div><span>supervisor</span><b>{current.pid === null ? '未登记' : 'pid ' + current.pid + '（归属 ' + current.ownership + '）'}</b></div>
                <div><span>作答子进程</span><b>{current.childPid === null ? '未启动' : 'pid ' + current.childPid + '（归属 ' + current.childOwnership + '）'}</b></div>
                <div><span>心跳</span><b>{time(current.heartbeatAt)}{current.leaseExpired ? ' · 租约已过期' : ''}</b></div>
                <div><span>计划</span><b>{current.plan.answers} 次 · {current.plan.taskIds.length} 题</b></div>
                <div><span>报告目录</span><b>{current.experiment.directory || '未登记'}</b></div>
              </div>
              <p>{current.merged.text}</p>
              <p>清理状态：{current.merged.cleanupText}</p>
              {current.exit !== null && <p>退出事实：code {String(current.exit.code)} · signal {String(current.exit.signal)} · {time(current.exit.at)} · 后代已确认退出 {current.exit.descendantsVerified ? '是' : '否（无法确认）'}{current.exit.note ? ' · ' + current.exit.note : ''}</p>}
              {current.note !== null && <p className="experiment-path">{current.note}</p>}
              <div className="launch-actions">
                <button className="secondary" disabled={busy || current.merged.process !== 'live'} aria-busy={busy}
                  title={cancelDisabledReason(busy, current.merged.process)}
                  onClick={() => void cancel(current.launchId)}>取消这次测评</button>
                <small className="experiment-path">{cancelDisabledReason(busy, current.merged.process)}</small>
                {current.args.length > 0 && <small className="experiment-path">子进程参数：{current.args.join(' ')}</small>}
              </div>
              {cancelText !== null && cancelResult?.launchId === current.launchId && <div className={'warn ' + (cancelText.confirmedExit ? '' : 'broken')} role="status">
                <b>取消结论：{cancelText.action}</b>
                <p>{cancelText.text}</p>
                <p>终止目标：{cancelText.targets.length === 0 ? '无（未由 API 直接终止任何进程）' : cancelText.targets.join('、')}</p>
              </div>}
              <p className={'state-tag ' + residueKind(current.residue.status)}>{residueText[current.residue.status]}</p>
              <p>{current.residue.detail}</p>
              {shown !== null && <>
                <h3>逐条作答 <small>{shown.rows.length} 条</small></h3>
                <div className="checks-table rows-table"><table>
                  <thead><tr><th>题目</th><th>预设</th><th>思考等级</th><th>次数</th><th>当前阶段</th></tr></thead>
                  <tbody>{shown.rows.map((row, index) => <tr key={row.taskId + '-' + row.preset + '-' + row.mode + '-' + row.repetition + '-' + index}>
                    <td><b>{row.taskId}</b></td><td>{row.preset}</td><td>{row.mode}</td><td>{row.repetition}</td>
                    <td><span className={'phase ' + phaseClass(row.phase)}>{phaseLabels[row.phase]}</span></td>
                  </tr>)}</tbody>
                </table></div>
                <h3>进度日志 <small>{shown.progress.length} 条</small></h3>
                <ol className="timeline">{shown.progress.map((entry, index) => <li key={entry.at + '-' + index}><b>{entry.message}</b><time>{time(entry.at)}</time></li>)}</ol>
              </>}
              {current.experiment.exists && shown === null && <p className="empty" role="status">实验目录已建立，正在读取逐条作答与进度…</p>}
            </>}
            <h3>清理这条启动记录</h3>
            <div className="cleanup-block">
              <p>清理会把该次测评的账本、退出事实、日志与取消标记一并移进启动记录根下的 <code>.trash</code>，启动记录列表不再显示它；文件不会删除。运行中或状态未知的记录会被服务端拒绝——账本是对账依据，移走会让进程失管。</p>
              <div className="token-bar">
                <label htmlFor="launch-clean-token">运行令牌</label>
                <input id="launch-clean-token" type="password" autoComplete="off" value={token} placeholder="x-bench-token" onChange={event => setToken(event.target.value)} />
                <span>与上方发起测评共用同一个令牌。</span>
              </div>
              {pendingCleanup === current.launchId
                ? <div className="warn broken" role="alert">
                  <b>确认清理 {current.launchId}？</b>
                  <p>该次测评的启动记录会整体移入回收目录。报告目录（data/experiments）不在此次清理范围内，对应条目请在「报告中心」单独清理。</p>
                  <div className="report-actions">
                    <button className="primary" onClick={() => void cleanLaunch(current.launchId)}>确认清理</button>
                    <button className="secondary" onClick={() => setPendingCleanup(null)}>取消</button>
                  </div>
                </div>
                : <div className="report-actions">
                  <button className="secondary" disabled={current.merged.process === 'live' || current.merged.process === 'unknown'} onClick={() => { setCleanupResult(null); setPendingCleanup(current.launchId); }}>清理这条记录…</button>
                  {cancelDisabledReason(false, current.merged.process)}
                </div>}
              {cleanupResult !== null && cleanupResult.launchId === current.launchId &&
                <div className={cleanupResult.ok ? 'ok-note' : 'error'} role="status">{cleanupResult.message}</div>}
            </div>
          </>}
        </article>
      </div>}

    <h3>提交外部作答</h3>
    <p>候选来自提交根（BENCH_SUBMISSIONS_DIR）下的子目录；提交复用既有的冻结与可用验证链路，不在这里另写一套。</p>
    <div className="launch-grid">
      <div className="launch-field">
        <label htmlFor="submission-candidate">候选目录</label>
        <select id="submission-candidate" value={submission.candidateDirectory} onChange={event => setSubmission(current => ({ ...current, candidateDirectory: event.target.value }))}>
          <option value="">请选择…</option>
          {(candidates?.candidates ?? []).map(item => <option key={item.name} value={item.name}>{item.name}（{item.files} 项）</option>)}
        </select>
        {candidates?.warning && <small>{candidates.warning}</small>}
        {candidates?.truncated && <small>候选较多，只列出前 200 条。</small>}
      </div>
      <div className="launch-field">
        <label htmlFor="submission-task">题目</label>
        <select id="submission-task" value={submission.taskId} onChange={event => setSubmission(current => ({ ...current, taskId: event.target.value }))}>
          {selectable.map(task => <option key={task.id} value={task.id}>{task.id}</option>)}
        </select>
        <label htmlFor="submission-key">幂等键（8–200 位字母数字与 _ . : -）</label>
        <input id="submission-key" value={submission.idempotencyKey} placeholder="external-2026-09-14-0001" onChange={event => setSubmission(current => ({ ...current, idempotencyKey: event.target.value }))} />
      </div>
      <div className="launch-field">
        <label htmlFor="submission-reason">提交原因</label>
        <select id="submission-reason" value={submission.reason} onChange={event => setSubmission(current => ({ ...current, reason: event.target.value }))}>
          {reasonOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <label className="launch-inline"><input type="checkbox" checked={submission.measure} onChange={event => setSubmission(current => ({ ...current, measure: event.target.checked }))} /> 本次启用性能测量</label>
        <button className="secondary" disabled={busy || submission.candidateDirectory === '' || submission.idempotencyKey.length < 8} onClick={() => void submitExternal()}>提交外部作答</button>
      </div>
    </div>
    {submissionResult && <div className="notice-inline" role="status">{submissionResult}</div>}
  </section>;
}