import { useEffect, useRef, useState } from 'react';
import {
  experimentDetailValidator, experimentListValidator,
  type ExperimentDetail, type ExperimentPhaseCounts, type ExperimentRow, type ExperimentSummary,
} from '@fsa/contracts';
import { useBenchToken } from './token.ts';
import { ProgressLog } from './ProgressLog.tsx';

const phaseLabels: Record<ExperimentRow['phase'], string> = {
  pending: '待作答', solving: '作答中', grading: '验证评分中', done: '已完成', 'solver-stopped': '作答中止', error: '出错',
};
const phaseOrder: ExperimentRow['phase'][] = ['pending', 'solving', 'grading', 'done', 'solver-stopped', 'error'];
const filterLabels = { all: '全部', running: '进行中', completed: '已完成', failed: '失败', unreadable: '不可读' } as const;
type ReportFilter = keyof typeof filterLabels;
const filterKeys = Object.keys(filterLabels) as ReportFilter[];
const cleanupLabels: Record<string, string> = { pending: '待清理', complete: '已清理', retained: '保留临时目录' };
const artifactLabels = { report: 'report.md', experiment: 'experiment.json', evidence: 'evidence.json.gz', log: 'launch.log' } as const;
const artifactIds = ['report', 'experiment', 'evidence', 'log'] as const;
const artifactNotes: Record<(typeof artifactIds)[number], string> = {
  report: 'Markdown 报告，与 experiment.json 同步落盘。',
  experiment: '原始 experiment.json，可离线复核。',
  evidence: '登记的作答证据压缩包。',
  log: '本阶段比较入口不产出启动日志，下载会返回 404「不适用」。',
};
const number = (value: number | null) => value === null ? '待定' : String(value);
const time = (value: string | null) => value === null ? '未登记' : new Date(value).toLocaleString('zh-CN');
const phaseClass = (phase: ExperimentRow['phase']) => phase === 'solver-stopped' ? 'stopped' : phase;
const phaseCount = (counts: ExperimentPhaseCounts, phase: ExperimentRow['phase']) => phase === 'solver-stopped' ? counts.solverStopped : counts[phase];

/** 状态徽标：损坏报告优先显示为不可读，绝不因为读不出就消失。 */
function stateOf(item: ExperimentSummary): { text: string; kind: 'ok' | 'warn' | 'bad' | 'idle' } {
  if (item.status === 'unreadable') return { text: '不可读', kind: 'bad' };
  if (item.state === 'running') return { text: '进行中', kind: 'ok' };
  if (item.state === 'completed') return { text: '已完成', kind: 'idle' };
  if (item.state === 'cancelled') return { text: '已取消', kind: 'warn' };
  if (item.state === 'failed') return { text: '失败', kind: 'bad' };
  return { text: item.state ?? '状态未知', kind: 'idle' };
}

function matchesFilter(item: ExperimentSummary, filter: ReportFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'unreadable') return item.status === 'unreadable';
  if (item.status !== 'ok') return false;
  if (filter === 'running') return item.state === 'running';
  if (filter === 'completed') return item.state === 'completed';
  return item.state === 'failed' || item.state === 'cancelled';
}

/** 关键词命中的范围：实验 id、题目编号、报告目录、供应商、模型、预设与思考等级。 */
function searchText(item: ExperimentSummary): string {
  return [item.id ?? '', item.directoryName, item.provider ?? '', item.model ?? '', item.presets.join(' '), item.modes.join(' ')].join(' ').toLowerCase();
}

/** 明细读不出来时的中文原因；422 表示报告损坏，必须带上服务端给出的理由。 */
function failureMessage(status: number, value: unknown): string {
  const detail = typeof value === 'object' && value !== null && 'error' in value ? String((value as { error: unknown }).error) : '';
  if (status === 422) return '该实验报告不可读（422）：' + (detail || '服务端未给出原因。');
  if (status === 404) return '未找到该实验报告（404）：' + (detail || '它可能已被移出报告根。');
  return '报告明细加载失败（' + status + '）' + (detail ? '：' + detail : '，请检查 API 服务并重试。');
}

function cleanupText(detail: ExperimentDetail): string {
  if (detail.cleanup === null) return '清理状态未登记。';
  const state = cleanupLabels[detail.cleanup.state] ?? detail.cleanup.state;
  const directory = detail.cleanup.directory ? ' · 临时目录 ' + detail.cleanup.directory : '';
  const reason = detail.cleanup.reason ? ' · ' + detail.cleanup.reason : '';
  return state + directory + reason;
}

/**
 * 一条作答记录的**落定状态**：把「跑完了没有」与「总分定没定」分开回答。
 *
 * · settled：作答完成（phase === done）且拿到数值总分；
 * · pending：作答完成但总分待定——它**已经跑完**，只差一份合格的质量证据，绝不是「未完成」；
 * · unfinished：真的没跑完（待作答 / 作答中 / 评分中 / 作答中止 / 出错）。
 *
 * 这里刻意不做「needsRerun = phase !== 'done' || total === null」那种合并：
 * 一份 state=completed、55/55 都 done 的报告里只要有 1 条待定（独立评审未通过协议校验），
 * 合并口径就会让页面说「续跑未完成的 1 条」并列出一个早已跑完的题。
 */
type RowStateKind = 'settled' | 'pending' | 'unfinished';
interface RowState { kind: RowStateKind; text: string; reason: string | null }
/**
 * 行状态徽标配色：待定是「如实留白」，既不写成失败（bad），也不借用通用的 `.warn`
 * ——后者会连带告警块的边框、内边距与外边距，把一枚小徽标撑成大块提示。
 * 中性色 + 明确的「作答完成 · 质量分待定」文字才是这里想要的表达。
 */
const rowStateKind: Record<RowStateKind, string> = { settled: 'ok', pending: 'idle', unfinished: 'bad' };

/**
 * 待定原因：只据出口协议**已有**的字段（`classification` / `total`）如实归纳，不新造字段、
 * 也不为了好看把原因藏起来。ExperimentRow 上没有 error 与 scoring.reason，所以这里说明的是
 * 「哪一类证据不全」并指向真正的原因所在：报告登记的 issues 与证据包 evidence.json.gz
 * 里的 review-error.json / review-round-<n>-error.json（失败轮的原始响应与字段路径）。
 */
function pendingReason(row: ExperimentRow): string {
  return '作答已完成（验证结论 ' + (row.classification ?? '未记录') + '），却没有数值总分：'
    + '质量证据不完整（独立评审缺失或未通过协议校验，或质量维度被判不可判）。'
    + '完整原因见本页「实验记录问题」与证据包 evidence.json.gz。';
}

/**
 * 进行中行的心跳文案："进行中 · 已 N 分 M 秒"。
 *
 * 为什么要这个：一次作答要跑满限时（实测 20 分钟）才返回结果，而这期间报告不再落盘，
 * 页面每 5 秒轮询到的都是同一份快照。没有它时页面看起来像卡死，有它时
 * "还在跑" 与 "已经死了" 立刻可区分。
 *
 * 计时用**收到这份数据时**的 Date.now()，而不是每次渲染重算：
 * 轮询间隔 5 秒，误差最多 5 秒，换来的是数字只在轮询时跳动，不会在两次渲染之间乱跳。
 * 心跳缺失（旧报告）返回 null，页面退回原来的静态文案。
 */
function liveElapsed(row: ExperimentRow, now: number): string | null {
  // 旧报告里没有这个字段（undefined），新报告收尾后是 null——两者都按「无心跳」处理。
  if (row.heartbeat == null) return null;
  const started = Date.parse(row.heartbeat.startedAt);
  if (!Number.isFinite(started)) return null;
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  const minutes = Math.floor(seconds / 60);
  return seconds < 60 ? seconds + ' 秒' : minutes + ' 分 ' + (seconds % 60) + ' 秒';
}

function rowState(row: ExperimentRow): RowState {
  if (row.phase === 'done' && typeof row.total === 'number') return { kind: 'settled', text: '作答完成 · 分数已出', reason: null };
  if (row.phase === 'done') return { kind: 'pending', text: '作答完成 · 质量分待定', reason: pendingReason(row) };
  return { kind: 'unfinished', text: '还没跑完（' + phaseLabels[row.phase] + '）', reason: null };
}

/**
 * 续跑按钮文案：计数口径与三类行一一对应。
 * 只有一类行需要重做时直接就那一类说话；两类都有时把两个数都写出来。
 * 绝不把「作答已完成但分数待定」写成「未完成」——那份报告的行其实都跑完了。
 */
function rerunButtonText(total: number, unfinished: number, pending: number): string {
  if (total === 0) return '续跑（没有需要重做的作答）…';
  if (unfinished === 0) return '重跑 ' + total + ' 条待定…';
  if (pending === 0) return '续跑未完成的 ' + total + ' 条…';
  return '续跑 ' + total + ' 条（未完成 ' + unfinished + ' + 待定 ' + pending + '）…';
}

/**
 * 报告级评分汇总：只对**已评分**的作答求平均，并把三类行各自计数。
 *
 * 关键规则（不得违反）：`total` 为 null 表示该次作答尚未取得完整证据（总分待定），
 * 它绝不能被当成 0 分参与平均——那会把一个「还不知道」的结果算成「很差」。
 * 「作答已完成但待定」与「还没跑完」同样是两个不同的数：前者的 phase 是 done，后者不是；
 * 合成一个计数就会让一份已完成的报告看起来还有没跑完的行。
 */
function scoreSummary(rows: ExperimentRow[]) {
  const states = rows.map(rowState);
  const scored = rows.filter((_, index) => states[index]!.kind === 'settled');
  const pending = rows.filter((_, index) => states[index]!.kind === 'pending').length;
  const unfinished = rows.filter((_, index) => states[index]!.kind === 'unfinished').length;
  const average = scored.length === 0 ? null : scored.reduce((sum, row) => sum + (row.total ?? 0), 0) / scored.length;
  const totals = scored.map(row => row.total as number);
  const sorted = [...totals].sort((left, right) => left - right);
  const median = sorted.length === 0 ? null : sorted.length % 2 === 1
    ? sorted[(sorted.length - 1) / 2]!
    : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
  const below = totals.filter(value => value < 70).length;
  return {
    scored: scored.length,
    pending,
    unfinished,
    average,
    median,
    minimum: sorted[0] ?? null,
    maximum: sorted.at(-1) ?? null,
    belowThreshold: below,
  };
}

/** 页面自行推导的一致性提示：跨题目版本或同组合重复记录都不可直接合并。 */
function consistencyHints(detail: ExperimentDetail): string[] {
  const hints: string[] = [];
  const versions = new Map<string, Set<string>>();
  const combinations = new Map<string, number>();
  for (const row of detail.rows) {
    const seen = versions.get(row.taskId) ?? new Set<string>();
    seen.add(row.taskVersion);
    versions.set(row.taskId, seen);
    const key = row.taskId + ' · ' + row.preset + ' / ' + row.mode + ' · 第 ' + row.repetition + ' 次';
    combinations.set(key, (combinations.get(key) ?? 0) + 1);
  }
  for (const [taskId, seen] of versions) {
    if (seen.size > 1) hints.push(taskId + ' 出现多个题目版本：' + [...seen].join('、') + '，跨版本的分数不可直接合并。');
  }
  for (const [key, count] of combinations) {
    if (count > 1) hints.push(key + ' 有 ' + count + ' 条重复记录，同一组合只应出现一次。');
  }
  return hints;
}

/**
 * 报告中心：只读展示 pnpm dsh:compare 落盘的实验报告。
 * 列表不会过滤掉损坏报告；明细失败（含 422）只在右栏给出原因，不影响页面其余部分。
 */
export function ReportCenter({ onCount }: { onCount?: (count: number) => void }) {
  const [experiments, setExperiments] = useState<ExperimentSummary[]>([]);
  // 清理是破坏性操作（会移走报告目录），因此走「先确认、再执行」两步，不做单击即清。
  const [pendingCleanup, setPendingCleanup] = useState<string | null>(null);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<{ reportId: string; message: string; ok: boolean } | null>(null);
  // 续跑（重试）：与清理同样是写操作，因此也要令牌，也走「先确认再执行」。
  const [pendingRetry, setPendingRetry] = useState<string | null>(null);
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryResult, setRetryResult] = useState<{ reportId: string; message: string; ok: boolean } | null>(null);
  /** 已发起续跑的报告：在界面上显示「续跑中」，让用户看到操作确实生效。 */
  const [retrying, setRetrying] = useState<{ reportId: string; launchId: string | null } | null>(null);
  const { token, setToken, authHeaders } = useBenchToken();

  /**
   * 续跑一份报告：只重做**该重做**的行——真的没跑完的（phase !== 'done'）与分数待定的
   * （phase === 'done' 但 total 为 null），已落定的分数原样保留。
   *
   * 这两类都要重跑，但它们不是一回事：没跑完是「还没做」，待定是「做完了但没有合格证据」。
   * 界面因此分开计数与措辞，绝不把待定叫成「未完成」——见下方续跑区块。
   */
  async function retryReport(reportId: string) {
    setRetryBusy(true);
    try {
      const response = await fetch('/api/experiments', { method: 'POST',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ resumeExperimentId: reportId }) });
      const value: unknown = await response.json().catch(() => null);
      const detail = typeof value === 'object' && value !== null && 'error' in value ? String((value as { error: unknown }).error) : '';
      if (!response.ok) {
        setRetryResult({ reportId, ok: false, message: response.status === 401 ? '令牌无效或已失效：' + (detail || '请检查运行令牌。') : '续跑失败（' + response.status + '）：' + (detail || '服务端未给出原因。') });
        return;
      }
      const launch = typeof value === 'object' && value !== null && 'launch' in value ? (value as { launch?: { launchId?: string } }).launch : undefined;
      setRetryResult({ reportId, ok: true, message: '已发起续跑（启动记录 ' + (launch?.launchId ?? '未登记') + '）：只重跑真的没跑完与分数待定的作答，已落定的分数不变。本页会自动跟随进度刷新，完成后直接显示新分数。' });
      setPendingRetry(null);
      setRetrying({ reportId, launchId: launch?.launchId ?? null });
      /**
       * 立刻进入轮询状态。
       *
       * 否则：报告此刻仍是 failed/旧状态，而轮询只在列表里**已有 running 报告**时才启动——
       * 续跑没能自己把界面推向轮询，页面看起来毫无变化，用户以为「点了没反应」。
       * 现在只要发起了续跑，就持续刷新，直到状态落定。
       */
      live.current = true;
      autoRef.current = true;
      setRevision(value => value + 1);
    } catch (cause) {
      setRetryResult({ reportId, ok: false, message: '续跑失败：' + (cause instanceof Error ? cause.message : '网络错误。') });
    } finally { setRetryBusy(false); }
  }

  /**
   * 清理一份报告：移到报告根的 .trash 下，可手动恢复。
   * 成功与失败都必须看得见——失败时把服务端的原话显示出来，不吞掉原因。
   */
  async function cleanReport(reportId: string) {
    setCleanupBusy(true);
    try {
      const response = await fetch('/api/reports/' + encodeURIComponent(reportId), { method: 'DELETE', headers: authHeaders() });
      const value: unknown = await response.json().catch(() => null);
      const detail = typeof value === 'object' && value !== null && 'error' in value ? String((value as { error: unknown }).error) : '';
      if (!response.ok) {
        setCleanupResult({ reportId, ok: false, message: response.status === 401 ? '令牌无效或已失效：' + (detail || '请检查运行令牌。') : '清理失败（' + response.status + '）：' + (detail || '服务端未给出原因。') });
        return;
      }
      const moved = typeof value === 'object' && value !== null && 'moved' in value ? (value as { moved: string[] }).moved : [];
      const trash = typeof value === 'object' && value !== null && 'trashPath' in value ? String((value as { trashPath: unknown }).trashPath) : '';
      setCleanupResult({ reportId, ok: true, message: '已移入回收目录：' + trash + '（原条目 ' + moved.join('、') + '）。需要恢复就把里面的条目移回报告根。' });
      setPendingCleanup(null);
      loadedRef.current = '';
      setDetail(null);
      setRevision(current => current + 1);
    } catch (cause) {
      setCleanupResult({ reportId, ok: false, message: '清理失败：' + (cause instanceof Error ? cause.message : '网络错误。') });
    } finally { setCleanupBusy(false); }
  }
  const [selection, setSelection] = useState('');
  const [detail, setDetail] = useState<ExperimentDetail | null>(null);
  // 明细失败按 reportId 记录：切换选择时旧的失败原因不会串到另一份报告上。
  const [failure, setFailure] = useState<{ reportId: string; message: string } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  // 每次成功拉取明细时记录时刻："已进行 N 分钟"以它为基准计算，
  // 这样数字只随轮询跳动（约每 5 秒一次），不会在两次渲染之间来回跳。
  const [polledAt, setPolledAt] = useState(() => Date.now());
  const [filter, setFilter] = useState<ReportFilter>('all');
  const [search, setSearch] = useState('');
  // 只有存在进行中的实验时才轮询：已完成的历史报告不重复请求。
  // 已加载的报告跳过重复请求，避免 5 秒重建一次正在阅读的表格；
  // 但进行中的实验仍然按轮询周期刷新明细，否则看不到阶段推进。
  const live = useRef(false);
  const loadedRef = useRef('');
  const autoRef = useRef(false);
  const keyword = search.trim().toLowerCase();
  const visible = experiments.filter(item => matchesFilter(item, filter) && searchText(item).includes(keyword));
  const current = visible.find(item => item.reportId === selection) ?? visible[0] ?? null;
  const currentId = current?.reportId ?? '';
  const shown = detail !== null && detail.reportId === currentId ? detail : null;
  useEffect(() => {
    const timer = setInterval(() => { if (live.current) { autoRef.current = true; setRevision(value => value + 1); } }, 5000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const polling = autoRef.current;
    autoRef.current = false;
    async function load() {
      const response = await fetch('/api/reports', { signal: controller.signal });
      if (!response.ok) throw new Error('报告列表加载失败（' + response.status + '），请检查 API 服务并重试。');
      const value: unknown = await response.json();
      if (!experimentListValidator.Check(value)) throw new Error('报告列表协议不匹配。');
      if (controller.signal.aborted) return;
      setExperiments(value);
      live.current = value.some(item => item.state === 'running');
      // 续跑的报告已不再进行中，说明这轮续跑落定了：撤掉「续跑中」，并把结论留在页面上。
      setRetrying(previous => {
        if (previous === null) return null;
        const target = value.find(item => item.reportId === previous.reportId);
        if (target === undefined || target.state === 'running') return previous;
        setRetryResult({ reportId: previous.reportId, ok: true,
          message: '续跑已完成（启动记录 ' + (previous.launchId ?? '未登记') + '）：报告已更新，下方分数与表格即最新结果。' });
        return null;
      });
      onCount?.(value.length);
      const listed = value.filter(item => matchesFilter(item, filter) && searchText(item).includes(keyword));
      const selected = listed.find(item => item.reportId === currentId) ?? listed[0] ?? null;
      setError('');
      // 同一报告不重取明细；只有"进行中"的实验在轮询周期里刷新，否则 5 秒一次的轮询会不断重建表格。
      if (selected === null) return;
      if (selected.reportId === loadedRef.current && !(polling && live.current)) return;
      // 损坏报告同样发一次明细请求：右栏展示的就是服务端 422 给出的原因。
      try {
        const detailResponse = await fetch('/api/reports/' + encodeURIComponent(selected.reportId), { signal: controller.signal });
        const data: unknown = await detailResponse.json().catch(() => null);
        if (controller.signal.aborted) return;
        if (!detailResponse.ok) throw new Error(failureMessage(detailResponse.status, data));
        if (!experimentDetailValidator.Check(data)) throw new Error('报告明细协议不匹配。');
        setDetail(data);
        setPolledAt(Date.now());
        setFailure(null);
        loadedRef.current = selected.reportId;
      } catch (cause) {
        if (controller.signal.aborted) return;
        setDetail(null);
        setFailure({ reportId: selected.reportId, message: cause instanceof Error ? cause.message : '报告明细加载失败。' });
        loadedRef.current = selected.reportId;
      }
    }
    void load().catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      loadedRef.current = '';
      setError(cause instanceof Error ? cause.message : '报告列表加载失败。');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
  }, [currentId, revision, filter, keyword, onCount]);
  const state = current === null ? null : stateOf(current);
  const currentFailure = failure !== null && failure.reportId === currentId ? failure.message : '';
  const hints = shown === null ? [] : consistencyHints(shown);
  return <section>
    <div className="section-head"><h2>报告中心 <small>{visible.length} / {experiments.length} 个实验</small></h2><button className="secondary" onClick={() => setRevision(value => value + 1)}>刷新报告</button></div>
    <p>只读展示 CLI 自动测评（pnpm dsh:compare）落盘的实验报告：逐条作答阶段、进度日志与四个产物下载。进行中的实验每 5 秒自动刷新；损坏的报告仍会列出并写明原因。</p>
    <div className="filters">
      <input aria-label="搜索实验" placeholder="搜索实验 id、目录、供应商、模型或预设…" value={search} onChange={event => setSearch(event.target.value)} />
      <select aria-label="报告状态" value={filter} onChange={event => setFilter(event.target.value as ReportFilter)}>{filterKeys.map(key => <option key={key} value={key}>{filterLabels[key]}</option>)}</select>
    </div>
    {error && <div className="error" role="alert">{error} <button onClick={() => setRevision(value => value + 1)}>重新加载</button></div>}
    {/* 清理结论必须放在列表之外：被清理的报告会立刻从列表消失，明细区随之换成空状态，
        若把结论渲染在明细区里，用户永远看不到自己刚做的事成功了没有。 */}
    {cleanupResult !== null && <div className={cleanupResult.ok ? 'ok-note' : 'error'} role="status">{cleanupResult.message}</div>}
    {/* 续跑结论同样放在页面级：明细面板会随刷新重绘，放在里面会一闪而过。 */}
    {retryResult !== null && <div className={retryResult.ok ? 'ok-note' : 'error'} role="status">{retryResult.message}</div>}
    {loading ? <div className="empty" role="status">正在加载实验报告…</div>
      : experiments.length === 0 ? <div className="empty"><h3>还没有实验报告</h3><p>运行 pnpm dsh:compare 产出实验目录后，报告会出现在这里。</p></div>
      : <div className="report-layout">
        <aside className="report-list" aria-label="选择实验报告">{visible.length === 0 ? <div className="empty">没有符合筛选条件的实验报告。</div> : visible.map(item => {
          const badge = stateOf(item);
          return <button key={item.reportId} aria-pressed={item.reportId === currentId} className={'report-item experiment-item' + (item.reportId === currentId ? ' selected' : '') + (item.status === 'unreadable' ? ' broken' : '')} onClick={() => setSelection(item.reportId)}>
            <b>{item.id ?? item.directoryName}</b><span className={'state-tag ' + badge.kind}>{badge.text}</span>
            <span>{item.provider ?? '供应商未登记'} / {item.model ?? '模型未登记'}</span>
            <span>完成 {item.phaseCounts.done} / 计划 {item.planned}{item.taskCount > 0 ? ' · ' + item.taskCount + ' 题' : ''}</span>
            <span>{item.startedAt === null ? '目录时间 ' + time(item.modifiedAt) : time(item.startedAt)}</span>
            {item.status === 'unreadable' && <span className="unreadable-reason">原因：{item.error ?? '未登记'}</span>}
          </button>;
        })}</aside>
        <article className="detail report-detail">
          {current === null ? <div className="empty"><h3>没有可展示的实验报告</h3><p>调整筛选条件或重新运行 pnpm dsh:compare。</p></div> : <>
            <div className="detail-top"><h2>{current.id ?? current.directoryName}</h2>{state && <span className={'state-tag ' + state.kind}>{state.text}</span>}
              {retrying !== null && retrying.reportId === current.reportId && <span className="state-tag ok">续跑中</span>}</div>
            <p className="experiment-path">报告目录 {current.directoryName} · 读取于 {time(current.modifiedAt)}</p>
            {current.status === 'unreadable'
              ? <div className="warn broken" role="alert"><b>该实验报告不可读</b><p>{current.error ?? '原因未登记。'}</p><p>列表不会隐藏损坏报告；修复 experiment.json 后点击「刷新报告」即可重新读取。明细请求会返回 422，页面其余部分不受影响。</p><button className="secondary" onClick={() => setRevision(value => value + 1)}>刷新报告</button></div>
              : currentFailure ? <div className="error" role="alert">{currentFailure}<button onClick={() => setRevision(value => value + 1)}>重新加载明细</button></div>
              : shown === null ? <div className="empty" role="status">正在加载报告明细…</div>
              : <>
                <div className="meta-grid">
                  <div><span>供应商 / 模型</span><b>{shown.provider ?? '未登记'} / {shown.model ?? '未登记'}</b></div>
                  <div><span>开始时间</span><b>{time(shown.startedAt)}</b></div>
                  <div><span>结束时间</span><b>{time(shown.finishedAt)}</b></div>
                  <div><span>计划 / 题目</span><b>{shown.planned} 次 / {shown.taskCount} 题</b></div>
                  <div><span>DSH 预设</span><b>{shown.presets.join('、') || '未登记'}</b></div>
                  <div><span>思考等级</span><b>{shown.modes.join('、') || '未登记'}</b></div>
                </div>
                <p>清理状态：{cleanupText(shown)}</p>
                <h3>阶段统计</h3>
                <div className="phase-summary">{phaseOrder.map(phase => <span className={'phase ' + phaseClass(phase)} key={phase}>{phaseLabels[phase]} {phaseCount(shown.phaseCounts, phase)}</span>)}</div>
                {shown.issues.length > 0 && <div className="warn" role="status"><b>实验记录问题 {shown.issues.length} 条</b><ul>{shown.issues.map((issue, index) => <li key={index + '-' + issue}>{issue}</li>)}</ul></div>}
                {hints.length > 0 && <div className="warn" role="status"><b>一致性提示 {hints.length} 条</b><p>以下由页面按记录推导，不是报告自身的结论。</p><ul>{hints.map(hint => <li key={hint}>{hint}</li>)}</ul></div>}
                <h3>总体评价</h3>
                {(() => {
                  const summary = scoreSummary(shown.rows);
                  const fixed = (value: number | null) => value === null ? '—' : value.toFixed(2);
                  return <>
                    <div className="summary-grid">
                      <div><span>已评分</span><b>{summary.scored} 条</b></div>
                      <div><span>作答已完成 / 计划</span><b>{summary.scored + summary.pending} / {shown.rows.length}</b></div>
                      <div><span>分数待定</span><b>{summary.pending} 条</b></div>
                      <div><span>还没跑完</span><b>{summary.unfinished} 条</b></div>
                      <div><span>平均总分</span><b>{fixed(summary.average)}{summary.average === null ? '' : ' /100'}</b></div>
                      <div><span>中位总分</span><b>{fixed(summary.median)}{summary.median === null ? '' : ' /100'}</b></div>
                      <div><span>最低 / 最高</span><b>{fixed(summary.minimum)} / {fixed(summary.maximum)}</b></div>
                      <div><span>低于 70 分</span><b>{summary.belowThreshold} 条</b></div>
                    </div>
                    <p className="field-hint">
                      {summary.scored === 0
                        ? '本次实验没有取得任何完整总分，无法给出平均分。'
                        : '平均分只覆盖已评分的 ' + summary.scored + ' 条作答。'}
                      {summary.pending > 0
                        ? '另有 ' + summary.pending + ' 条作答「已经跑完、但总分待定」（缺完整证据），它们不参与平均——把待定当成 0 分会把「还不知道」误报成「很差」。'
                        : '没有「跑完但总分待定」的作答。'}
                      {summary.unfinished > 0 ? ' 还有 ' + summary.unfinished + ' 条真的没有跑完，见下方「当前阶段」。' : ' 计划中的作答都已跑完。'}
                      {' 「已评分」「分数待定」「还没跑完」是三个不同的数，不能相加成一个「完成度」。'}
                      {summary.pending > 0 && ' 待定的条目见下方表格中「分数」列为「待定」的行。'}
                    </p>
                  </>;
                })()}
                <h3>逐条作答 <small>{shown.rows.length} 条</small></h3>
                {/* 行级状态是三种说法，不是两种：跑完且分数已出 / 跑完但分数待定（写明原因）/ 真的没跑完。
                    「跑完但待定」一旦被叫成「未完成」，一份 state=completed 的报告就会看起来还有没跑完的行。 */}
                {shown.rows.length === 0 ? <div className="empty">该实验没有作答记录。</div> : <div className="checks-table rows-table"><table>
                  <thead><tr><th>题目</th><th>预设</th><th>思考等级</th><th>次数</th><th>当前阶段</th><th>行级状态</th><th>待定原因</th><th>结束原因</th><th>作答秒数</th><th>验证结论</th><th>分数</th><th>运行 / 尝试</th></tr></thead>
                  <tbody>{shown.rows.map((row, index) => {
                    const state = rowState(row);
                    return <tr key={row.taskId + '-' + row.preset + '-' + row.mode + '-' + row.repetition + '-' + index}>
                    <td><b>{row.taskId}</b> <small>{row.taskVersion}</small></td>
                    <td>{row.preset}</td>
                    <td>{row.mode}</td>
                    <td>{row.repetition}</td>
                    <td><span className={'phase ' + phaseClass(row.phase)}>{phaseLabels[row.phase]}</span></td>
                    <td><span className={'state-tag ' + rowStateKind[state.kind]}>{state.text}</span></td>
                    {/* 原因要完整可读：它比别的列长得多，若不换行会把整张表撑得很宽（表格全局 nowrap）。 */}
                    <td style={{ whiteSpace: 'normal', minWidth: '240px' }}>{state.reason ?? '—'}</td>
                    <td>{row.finishReason ?? '—'}</td>
                    {/* 作答秒数：已跑完用 solver 给的实测值；进行中用心跳算"已进行 N"，
                        并标出最后心跳距今多久——那一刻停住不动就是真卡住了。 */}
                    <td>{row.durationMs === null
                      ? (() => { const live = liveElapsed(row, polledAt); return live === null ? '—' : <span className="live-elapsed">{live}</span>; })()
                      : (row.durationMs / 1000).toFixed(1)}</td>
                    {/* 「验证结论」只回答验证本身：跑完的行没有结论时写「结论未登记」，绝不能写成像没跑过的样子。 */}
                    <td>{row.classification ?? (row.phase === 'done' ? '结论未登记' : '尚无结论')}</td>
                    <td>{number(row.total)}</td>
                    <td>{row.runId && row.attemptId ? row.runId + '/' + row.attemptId : '—'}</td>
                  </tr>; })}</tbody>
                </table></div>}
                <ProgressLog entries={shown.progress} key={shown.id ?? shown.directoryName} />
                <h3>产物下载</h3>
                <div className="artifact-grid">{artifactIds.map(id => <div className="artifact" key={id}>
                  <a href={'/api/reports/' + encodeURIComponent(shown.reportId) + '/artifacts/' + id} download>{artifactLabels[id]} ↗</a>
                  <p>{id === 'evidence' ? shown.evidence === null ? '证据未归档（experiment.json 未登记 evidence）。' : shown.evidence.filename + ' · SHA-256 ' + shown.evidence.sha256.slice(0, 16) + '… · ' + shown.evidence.fileCount + ' 个文件' : artifactNotes[id]}</p>
                </div>)}</div>
                <h3>续跑这份报告</h3>
                {(() => {
                  // 需要重做 = 真的没跑完 + 分数待定。两类都要重做（isSettledRow 同样要求数值总分），
                  // 但计数与文案分开：它们不是一回事，混成一个数就会把「做完了、证据不够」说成「没跑完」。
                  const unfinishedRows = shown.rows.filter(row => row.phase !== 'done');
                  const pendingRows = shown.rows.filter(row => row.phase === 'done' && typeof row.total !== 'number');
                  const needsRerun = [...unfinishedRows, ...pendingRows];
                  const ids = (rows: ExperimentRow[]) => rows.slice(0, 8).map(row => row.taskId).join('、') + (rows.length > 8 ? ' 等' : '');
                  return <div className="cleanup-block">
                    <p>
                      续跑只重做两类作答：真的没跑完的（待作答 / 作答中 / 评分中 / 作答中止 / 出错）与分数待定的
                      （作答已完成、但缺完整证据拿不到总分）。已落定的分数原样保留，绝不重跑。
                    </p>
                    <ul>
                      <li>没跑完：<b>{unfinishedRows.length} 条</b>{unfinishedRows.length > 0 ? '（' + ids(unfinishedRows) + '）' : ''}</li>
                      <li>作答已完成但分数待定：<b>{pendingRows.length} 条</b>{pendingRows.length > 0 ? '（' + ids(pendingRows) + '）' : ''}</li>
                    </ul>
                    <p>
                      {needsRerun.length === 0
                        ? '这份报告的作答全部已经跑完并取得分数，没有需要重做的：上面「还没有跑完」为 0，行级状态里也没有「作答完成 · 质量分待定」。'
                        : '当前有 ' + needsRerun.length + ' 条需要重做：没跑完 ' + unfinishedRows.length + ' 条 + 分数待定 ' + pendingRows.length + ' 条。'
                          + (pendingRows.length > 0 ? ' 待定的那 ' + pendingRows.length + ' 条其实已经跑完，重跑是为了补一份合格的质量证据，不是「补做没做完的题」。' : '')}
                    </p>
                    {pendingRetry === shown.reportId
                      ? <div className="warn broken" role="alert">
                        <b>确认续跑「{shown.id ?? shown.directoryName}」？</b>
                        <p>会真实调用模型重做这 {needsRerun.length} 条作答（没跑完 {unfinishedRows.length} 条 + 分数待定 {pendingRows.length} 条）；已落定的 {shown.rows.length - needsRerun.length} 条不会重跑，分数也不会变。续跑在同一份报告上累积，产生一次新的「启动记录」。</p>
                        <div className="report-actions">
                          <button className="primary" disabled={retryBusy} aria-busy={retryBusy} onClick={() => void retryReport(shown.reportId)}>{retryBusy ? '正在发起…' : '确认续跑'}</button>
                          <button className="secondary" disabled={retryBusy} onClick={() => setPendingRetry(null)}>取消</button>
                        </div>
                      </div>
                      : <div className="report-actions">
                        <button className="secondary" disabled={retryBusy || needsRerun.length === 0}
                          title={needsRerun.length === 0
                            ? '这份报告的作答全部已经跑完并取得分数，没有需要重做的。'
                            : '只重做 ' + needsRerun.length + ' 条：没跑完 ' + unfinishedRows.length + ' 条 + 分数待定 ' + pendingRows.length + ' 条。'}
                          onClick={() => { setRetryResult(null); setPendingRetry(shown.reportId); }}>{rerunButtonText(needsRerun.length, unfinishedRows.length, pendingRows.length)}</button>
                        <span>不会改动已落定的分数。</span>
                      </div>}
                  </div>;
                })()}
                <h3>清理这份报告</h3>
                <div className="cleanup-block">
                  <p>清理会把报告目录移进报告根下的 <code>.trash</code>，列表立即不再显示它；文件不会删除，随时可以手动移回。清理后本页需要刷新才能看到变化。</p>
                  <div className="token-bar">
                    <label htmlFor="report-token">运行令牌</label>
                    <input id="report-token" type="password" autoComplete="off" value={token} placeholder="x-bench-token" onChange={event => setToken(event.target.value)} />
                    <span>清理属于写操作，必须提供有效令牌；与「发起测评」用的是同一个令牌。</span>
                  </div>
                  {pendingCleanup === shown.reportId
                    ? <div className="warn broken" role="alert">
                      <b>确认清理「{shown.id ?? shown.directoryName}」？</b>
                      <p>该报告目录会整体移入回收目录。它包含 experiment.json、report.md 与证据压缩包；移走后本页与报告列表都不再显示它。</p>
                      <div className="report-actions">
                        <button className="primary" disabled={cleanupBusy} onClick={() => void cleanReport(shown.reportId)}>确认清理</button>
                        <button className="secondary" disabled={cleanupBusy} onClick={() => setPendingCleanup(null)}>取消</button>
                      </div>
                    </div>
                    : <div className="report-actions">
                      <button className="secondary" disabled={cleanupBusy} onClick={() => { setCleanupResult(null); setPendingCleanup(shown.reportId); }}>清理这份报告…</button>
                      <span>不会删除文件，只移入回收目录。</span>
                    </div>}
                </div>
                <footer className="report-meta">实验 {shown.id ?? shown.directoryName} · 状态 {shown.state ?? '未登记'}<br />experiment.json · {shown.rows.length} 条记录 · {shown.progress.length} 条进度</footer>
              </>}
          </>}
        </article>
      </div>}
  </section>;
}