import { useEffect, useState } from 'react';
import { difficultyLabels, runDetailValidator, runStatusesValidator, suiteReportValidator, type RunDetail, type RunStatus, type SuiteReport } from '@fsa/contracts';

const scoreText = (value: number | null) => value === null ? '待定' : String(value);
const modeLabels = { local: '本机诊断', rehearsal: '校准/演练', formal: '正式成绩', pending: '待验证' } as const;

export function RunPanel() {
  const [runs, setRuns] = useState<RunStatus[]>([]);
  const [selection, setSelection] = useState('');
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedRuns, setSelectedRuns] = useState<string[]>([]);
  const [summary, setSummary] = useState<SuiteReport | null>(null);
  async function summarize() {
    try {
      const response = await fetch('/api/summaries', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(selectedRuns.map(key => { const [runId, attemptId] = key.split('/'); return { runId, attemptId }; })) });
      const value: unknown = await response.json();
      if (!response.ok) throw new Error(typeof value === 'object' && value !== null && 'error' in value ? String(value.error) : '汇总失败。');
      if (!suiteReportValidator.Check(value)) throw new Error('汇总协议不匹配。');
      setSummary(value); setError('');
    } catch (cause) { setSummary(null); setError(cause instanceof Error ? cause.message : '汇总失败。'); }
  }
  useEffect(() => {
    const timer = setInterval(() => setRevision(value => value + 1), 5000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      const response = await fetch('/api/runs', { signal: controller.signal });
      if (!response.ok) throw new Error('运行记录加载失败。');
      const value: unknown = await response.json();
      if (!runStatusesValidator.Check(value)) throw new Error('运行记录协议不匹配。');
      if (controller.signal.aborted) return;
      setRuns(value);
      const current = value.find(run => `${run.runId}/${run.attemptId}` === selection) ?? value.at(-1);
      if (!current) { setDetail(null); return; }
      const detailResponse = await fetch(`/api/runs/${encodeURIComponent(current.runId)}/${encodeURIComponent(current.attemptId)}/detail`, { signal: controller.signal });
      if (!detailResponse.ok) throw new Error('运行详情加载失败。');
      const data: unknown = await detailResponse.json();
      if (!runDetailValidator.Check(data)) throw new Error('运行详情协议不匹配。');
      if (!controller.signal.aborted) { setDetail(data); setError(''); }
    }
    void load().catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '加载失败。');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [selection, revision]);

  const status = detail?.status;
  const path = status ? `/api/runs/${encodeURIComponent(status.runId)}/${encodeURIComponent(status.attemptId)}` : '';
  return <section>
    <div className="section-head"><h2>运行记录 <small>{runs.length} 次作答</small></h2><button className="secondary" onClick={() => setRevision(value => value + 1)}>刷新记录</button></div>
    <p>按冻结快照查看执行、评分与事件。每 5 秒刷新；本机诊断和演练不会显示为正式成绩。</p>
    {error && <div className="error" role="alert">{error}</div>}
    <div className="report-actions"><button className="secondary" disabled={selectedRuns.length === 0} onClick={() => void summarize()}>汇总所选 {selectedRuns.length} 次作答</button><span>每题选择一次；不同环境分开汇总。</span></div>
    {summary && <article className="detail suite-summary"><h3>四级汇总 · {modeLabels[summary.mode]}</h3><div className="checks-table"><table><thead><tr><th>等级</th><th>已完整评分</th><th>均分</th><th>达标</th></tr></thead><tbody>{summary.levels.map(level => <tr key={level.difficulty}><td>{difficultyLabels[level.difficulty]}</td><td>{level.completed} / {level.expected}</td><td>{scoreText(level.score)}</td><td>{level.score === null ? '待定' : level.passed ? '是' : '否'}</td></tr>)}</tbody></table></div><p>核心加权总分：{scoreText(summary.weightedTotal)} /100 · 连续最高等级：{summary.highestConsecutiveLevel ? difficultyLabels[summary.highestConsecutiveLevel] : '尚未取得'}</p><p>集成题：{summary.selected.filter(item => item.track === 'integration').map(item => `${item.taskId} ${scoreText(item.total)}`).join('；') || '未选择'}。未完整测量的等级不重新归一化。</p><a href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(summary, null, 2))}`} download="benchmark-summary.json">下载汇总与作答选择</a></article>}
    {loading ? <div className="empty" role="status">正在加载运行记录…</div> : !detail ? <div className="empty"><h3>还没有运行记录</h3><p>使用 CLI 提交独立候选工作区，系统会自动冻结并验证。完整评分需要真实质量证据。</p></div> :
      <div className="report-layout">
        <aside className="report-list" aria-label="选择运行记录">{[...runs].reverse().map(run => <div key={`${run.runId}/${run.attemptId}`}><label className="run-select"><input type="checkbox" aria-label={`加入汇总 ${run.taskId} ${run.runId}/${run.attemptId}`} checked={selectedRuns.includes(`${run.runId}/${run.attemptId}`)} onChange={event => { const key = `${run.runId}/${run.attemptId}`; setSelectedRuns(current => event.target.checked ? [...current, key] : current.filter(item => item !== key)); setSummary(null); }} />加入汇总</label><button className={`report-item ${run.runId === status?.runId && run.attemptId === status.attemptId ? 'selected' : ''}`} onClick={() => setSelection(`${run.runId}/${run.attemptId}`)}>
          <b>{run.taskId}</b><strong>{scoreText(run.scoring.total)}<small> /100</small></strong><span>{modeLabels[run.scoring.mode]} · {run.classification ?? '等待/执行中'}</span><span>{new Date(run.frozenAt).toLocaleString('zh-CN')}</span>
        </button></div>)}</aside>
        <article className="detail report-detail">
          <div className="detail-top"><h2>{status?.taskId} · 执行报告</h2><span className="pill">{status && modeLabels[status.scoring.mode]}</span></div>
          <div className="score-hero"><strong>{scoreText(status?.scoring.total ?? null)}<small> /100</small></strong><span>{status?.classification ?? '尚未完成验证'}</span></div>
          <div className="score-pair"><div>可用验证 <b>{scoreText(status?.scoring.functional ?? null)} /50</b></div><div>代码质量 <b>{scoreText(status?.scoring.quality ?? null)} /50</b></div></div>
          <p>{status?.scoring.reason}</p>
          <p>隔离：{detail.execution?.isolation === 'container' ? 'Linux 容器' : '无容器隔离'} · 题目版本 {status?.taskVersion}</p>
          <div className="report-actions"><a className="secondary" href={`${path}/report`} download>下载 Markdown 报告</a><a className="secondary" href={`${path}/detail`} download>下载 JSON 与事件</a></div>
          <h3>代码质量分项</h3>{Object.entries({ simplicity: '简洁度', maintainability: '人工可维护性', decoupling: '解耦性', performance: '性能' } as const).map(([key, label]) => <div className="metric" key={key}><span>{label}</span><b>{scoreText(detail.score?.dimensions[key as keyof NonNullable<RunDetail['score']>['dimensions']] ?? null)} /100</b></div>)}
          <h3>检查结果</h3><div className="checks-table"><table><thead><tr><th>检查</th><th>状态</th><th>关键项</th></tr></thead><tbody>{detail.execution?.checks.map(check => <tr key={check.id}><td>{check.id}</td><td>{check.status}</td><td>{check.critical ? '是' : '否'}</td></tr>)}</tbody></table></div>
          <h3>执行时间线</h3><ol className="timeline">{detail.events.map(event => <li key={event.id}><b>{event.seq}. {event.type}</b><time>{new Date(event.at).toLocaleString('zh-CN')}</time><span>{event.actor}</span></li>)}</ol>
          <h3>可复核证据</h3>{status?.artifacts.map(artifact => <div className="evidence" key={artifact.id}><a href={`${path}/artifacts/${encodeURIComponent(artifact.id)}`} download>{artifact.id} ↗</a><p>{artifact.bytes} 字节 · SHA-256 {artifact.sha256.slice(0, 16)}…</p></div>)}
          <footer className="report-meta">候选摘要 {status?.candidateTreeHash}<br />{status?.runId} / {status?.attemptId}</footer>
        </article>
      </div>}
  </section>;
}
