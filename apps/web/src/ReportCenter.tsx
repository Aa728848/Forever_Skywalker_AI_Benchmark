import { useEffect, useRef, useState } from 'react';
import {
  experimentDetailValidator, experimentListValidator,
  type ExperimentDetail, type ExperimentPhaseCounts, type ExperimentRow, type ExperimentSummary,
} from '@fsa/contracts';
import { useBenchToken } from './token.ts';

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
 * 报告级评分汇总：只对**已评分**的作答求平均。
 *
 * 关键规则：`total` 为 null 表示该次作答尚未取得完整证据（总分待定），
 * 它绝不能被当成 0 分参与平均——那会把一个「还不知道」的结果算成「很差」。
 * 因此待定项单独计数并如实显示，平均分只覆盖有分数的那些。
 */
function scoreSummary(rows: ExperimentRow[]) {
  const scored = rows.filter(row => row.total !== null);
  const pending = rows.length - scored.length;
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
  const { token, setToken, authHeaders } = useBenchToken();

  /**
   * 续跑一份报告：只补跑未完成/未作答/待定的作答，已落定的分数原样保留。
   * 这是「不应该有待定」的修复入口——待定行的 phase 也是 done，只有续跑能重做它们。
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
      setRetryResult({ reportId, ok: true, message: '已发起续跑（启动记录 ' + (launch?.launchId ?? '未登记') + '）：只重跑未完成与待定的作答，已完成的分数不变。进度见「启动记录」，完成后本页刷新即可看到新分数。' });
      setPendingRetry(null);
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
            <div className="detail-top"><h2>{current.id ?? current.directoryName}</h2>{state && <span className={'state-tag ' + state.kind}>{state.text}</span>}</div>
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
                      <div><span>平均总分</span><b>{fixed(summary.average)}{summary.average === null ? '' : ' /100'}</b></div>
                      <div><span>中位总分</span><b>{fixed(summary.median)}{summary.median === null ? '' : ' /100'}</b></div>
                      <div><span>最低 / 最高</span><b>{fixed(summary.minimum)} / {fixed(summary.maximum)}</b></div>
                      <div><span>已评分 / 待定</span><b>{summary.scored} / {summary.pending}</b></div>
                      <div><span>低于 70 分</span><b>{summary.belowThreshold} 条</b></div>
                    </div>
                    <p className="field-hint">
                      {summary.scored === 0
                        ? '本次实验没有取得任何完整总分，无法给出平均分。'
                        : '平均分只覆盖已评分的 ' + summary.scored + ' 条作答；' + (summary.pending === 0 ? '全部作答都已评分。' : '另有 ' + summary.pending + ' 条总分待定（缺完整证据），它们不参与平均——把待定当成 0 分会把「还不知道」误报成「很差」。')}
                      {summary.pending > 0 && ' 待定的条目见下方表格中「分数」列为「待定」的行。'}
                    </p>
                  </>;
                })()}
                <h3>逐条作答 <small>{shown.rows.length} 条</small></h3>
                {shown.rows.length === 0 ? <div className="empty">该实验没有作答记录。</div> : <div className="checks-table rows-table"><table>
                  <thead><tr><th>题目</th><th>预设</th><th>思考等级</th><th>次数</th><th>当前阶段</th><th>结束原因</th><th>作答秒数</th><th>验证结论</th><th>分数</th><th>运行 / 尝试</th></tr></thead>
                  <tbody>{shown.rows.map((row, index) => <tr key={row.taskId + '-' + row.preset + '-' + row.mode + '-' + row.repetition + '-' + index}>
                    <td><b>{row.taskId}</b> <small>{row.taskVersion}</small></td>
                    <td>{row.preset}</td>
                    <td>{row.mode}</td>
                    <td>{row.repetition}</td>
                    <td><span className={'phase ' + phaseClass(row.phase)}>{phaseLabels[row.phase]}</span></td>
                    <td>{row.finishReason ?? '—'}</td>
                    <td>{row.durationMs === null ? '—' : (row.durationMs / 1000).toFixed(1)}</td>
                    <td>{row.classification ?? '未评分'}</td>
                    <td>{number(row.total)}</td>
                    <td>{row.runId && row.attemptId ? row.runId + '/' + row.attemptId : '—'}</td>
                  </tr>)}</tbody>
                </table></div>}
                <h3>进度日志 <small>{shown.progress.length} 条</small></h3>
                {shown.progress.length === 0 ? <div className="empty">该实验未记录进度日志（0.2.0 报告没有该字段）。</div> : <ol className="timeline">{shown.progress.map((entry, index) => <li key={entry.at + '-' + index}><b>{entry.message}</b><time>{time(entry.at)}</time></li>)}</ol>}
                <h3>产物下载</h3>
                <div className="artifact-grid">{artifactIds.map(id => <div className="artifact" key={id}>
                  <a href={'/api/reports/' + encodeURIComponent(shown.reportId) + '/artifacts/' + id} download>{artifactLabels[id]} ↗</a>
                  <p>{id === 'evidence' ? shown.evidence === null ? '证据未归档（experiment.json 未登记 evidence）。' : shown.evidence.filename + ' · SHA-256 ' + shown.evidence.sha256.slice(0, 16) + '… · ' + shown.evidence.fileCount + ' 个文件' : artifactNotes[id]}</p>
                </div>)}</div>
                <h3>续跑未完成的作答</h3>
                {(() => {
                  // 「需要续跑」与评分汇总同一判据：必须拿到数值总分才算落定。
                  // 待定行的 phase 也是 done，只按 phase 判断会漏掉它们——那正是修不好待定的原因。
                  const needsRerun = shown.rows.filter(row => row.phase !== 'done' || typeof row.total !== 'number');
                  return <div className="cleanup-block">
                    <p>
                      续跑只重做未完成、未作答与分数待定的作答，已落定的分数原样保留。
                      {needsRerun.length === 0
                        ? ' 当前这份报告没有需要续跑的作答。'
                        : ' 当前有 ' + needsRerun.length + ' 条需要续跑：' + needsRerun.slice(0, 8).map(row => row.taskId).join('、') + (needsRerun.length > 8 ? ' 等' : '') + '。'}
                    </p>
                    {pendingRetry === shown.reportId
                      ? <div className="warn broken" role="alert">
                        <b>确认续跑「{shown.id ?? shown.directoryName}」？</b>
                        <p>会真实调用模型重跑那 {needsRerun.length} 条作答；已完成的 {shown.rows.length - needsRerun.length} 条不会重跑，分数也不会变。续跑在同一份报告上累积，产生一次新的「启动记录」。</p>
                        <div className="report-actions">
                          <button className="primary" disabled={retryBusy} aria-busy={retryBusy} onClick={() => void retryReport(shown.reportId)}>{retryBusy ? '正在发起…' : '确认续跑'}</button>
                          <button className="secondary" disabled={retryBusy} onClick={() => setPendingRetry(null)}>取消</button>
                        </div>
                      </div>
                      : <div className="report-actions">
                        <button className="secondary" disabled={retryBusy || needsRerun.length === 0}
                          title={needsRerun.length === 0 ? '这份报告没有未完成或待定的作答。' : '只重跑 ' + needsRerun.length + ' 条未完成/待定的作答。'}
                          onClick={() => { setRetryResult(null); setPendingRetry(shown.reportId); }}>续跑未完成的 {needsRerun.length} 条…</button>
                        <span>不会改动已完成的分数。</span>
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