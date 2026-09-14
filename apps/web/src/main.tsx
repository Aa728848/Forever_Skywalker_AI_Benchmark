import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { difficultyLabels, tasksValidator, reportsValidator, reportValidator, type Task, type PreviewReport } from '@fsa/contracts';
import example from '../../../examples/assessment.json';
import './style.css';
import { RunPanel } from './RunPanel.tsx';

const qualityLabels = { simplicity: '简洁度', maintainability: '人工可维护性', decoupling: '解耦性', performance: '性能' } as const;
const number = (value: number | null) => value === null ? '待定' : String(value);

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error(`请求失败（${response.status}），请检查 API 服务并重试。`);
  return response.json() as Promise<unknown>;
}

function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [reports, setReports] = useState<PreviewReport[]>([]);
  const [tab, setTab] = useState<'catalog' | 'reports' | 'runs'>('catalog');
  const [difficulty, setDifficulty] = useState('all');
  const [domain, setDomain] = useState('all');
  const [track, setTrack] = useState('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState('CACHE-01');
  const [activeReport, setActiveReport] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void Promise.all([request('/api/tasks', { signal: controller.signal }), request('/api/previews', { signal: controller.signal })])
      .then(([taskData, reportData]) => {
        if (!tasksValidator.Check(taskData) || !reportsValidator.Check(reportData)) throw new Error('服务返回的数据协议不匹配。');
        setTasks(taskData);
        setReports(reportData);
      }).catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '加载失败。'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);
  const filtered = tasks.filter(task =>
    (difficulty === 'all' || task.difficulty === difficulty) && (domain === 'all' || task.domain === domain) && (track === 'all' || task.track === track)
    && `${task.id} ${task.title} ${task.sources.join(' ')}`.toLowerCase().includes(search.toLowerCase()));
  const current = filtered.find(task => task.id === selected) ?? filtered[0];
  const report = reports.find(item => item.id === activeReport) ?? reports[0];
  const packaged = tasks.filter(task => task.status !== 'designed').length;
  const taskState = { designed: '设计规格', 'fixture-ready': '题目包已验证', calibrating: '校准中', ready: '已发布' } as const;
  async function createExample() {
    setSaving(true);
    setError('');
    try {
      const data = await request('/api/previews', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(example) });
      if (!reportValidator.Check(data)) throw new Error('报告数据协议不匹配。');
      setReports(previous => [data, ...previous]);
      setActiveReport(data.id);
      setTab('reports');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '生成预览失败。'); }
    finally { setSaving(false); }
  }
  return <div className="shell">
    <aside className="sidebar">
      <a className="brand" href="/"><span className="brand-mark">F<span>✦</span></span><span>FOREVER<br /><b>SKYWALKER</b></span></a>
      <div className="side-label">AI ENGINEERING BENCHMARK</div>
      <nav aria-label="主导航">
        <button className={tab === 'catalog' ? 'nav active' : 'nav'} onClick={() => setTab('catalog')}><span>▦</span> 题目目录 <small>55</small></button>
        <button className={tab === 'reports' ? 'nav active' : 'nav'} onClick={() => setTab('reports')}><span>◫</span> 评分预览 <small>{reports.length}</small></button>
        <button className={tab === 'runs' ? 'nav active' : 'nav'} onClick={() => setTab('runs')}><span>◷</span> 运行记录</button>
      </nav>
      <div className="side-footer"><span className="status-dot" /> {packaged} / 55 题目包已验证<p>真实场景 · 四级评测<br />可用验证与代码质量各占 50%</p></div>
    </aside>
    <main>
      <header className="topbar"><span>工作台 <span className="slash">/</span> {tab === 'catalog' ? '测试集设计' : '报告与证据'}</span><span className="pill">本地工作区</span></header>
      <div className="content">
        <section className="heading"><div><div className="eyebrow">FOREVER SKYWALKER / BENCHMARK</div><h1>{tab === 'catalog' ? '让工程能力，经得起验证。' : '每一项评分，都有据可查。'}</h1><p>从真实项目出发，评估复杂工程任务的可用性与代码质量。</p></div><button className="primary" disabled={saving || loading} onClick={() => void createExample()}>{saving ? '正在生成…' : '生成示例评分'} <span>↗</span></button></section>
        <div className="notice"><b>{packaged} / 55 题目包已验证</b><span>难度为设计标签，尚未通过真实模型作答校准。题目包、反例检出与容器实跑分别验收；缺少客观或评审证据时总分待定。</span></div>
        {error && <div className="error" role="alert">{error} <button onClick={() => setReload(value => value + 1)}>重新加载</button></div>}
        <section className="stats" aria-label="题库概况">{[['55', '设计题目', '来自 7 个真实项目'], ['48', '核心题目', '12 个能力域 × 4 个难度'], ['7', '原仓库集成题', '独立报告 · 固定源码版本'], ['50 / 50', '评分比例', '可用验证 / 代码质量']].map(([value, label, caption]) => <article key={label}><span>{label}</span><strong>{value}</strong><small>{caption}</small></article>)}</section>
        {loading ? <div className="empty" role="status">正在加载题库与报告…</div> : tab === 'runs' ? <RunPanel /> : tab === 'catalog' ? <>
          <section className="section-head"><h2>题目目录 <small>{filtered.length} 道</small></h2><span>简单 → 中等 → 困难 → 极度困难</span></section>
          <div className="filters"><input aria-label="搜索题目" placeholder="搜索题目、编号或来源项目…" value={search} onChange={event => setSearch(event.target.value)} /><select aria-label="难度" value={difficulty} onChange={event => setDifficulty(event.target.value)}><option value="all">全部难度</option>{Object.entries(difficultyLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><select aria-label="能力域" value={domain} onChange={event => setDomain(event.target.value)}><option value="all">全部能力域</option>{[...new Set(tasks.map(task => task.domain))].map(value => <option key={value}>{value}</option>)}</select><select aria-label="题型" value={track} onChange={event => setTrack(event.target.value)}><option value="all">全部题型</option><option value="core">核心题</option><option value="integration">集成题</option></select></div>
          <div className="catalog-grid"><div className="task-list">{filtered.length === 0 ? <div className="empty">没有符合筛选条件的题目。</div> : filtered.map(task => <button key={task.id} aria-pressed={current?.id === task.id} className={`task-row ${current?.id === task.id ? 'selected' : ''}`} onClick={() => setSelected(task.id)}><span className="task-icon">{task.track === 'core' ? '◇' : '▧'}</span><span className="task-name"><span className="task-id">{task.id} · {task.domain}</span><b>{task.title}</b><small>{task.sources.join(' / ')}</small></span><span className={`badge ${task.difficulty}`}>{difficultyLabels[task.difficulty]}</span><span className="arrow">›</span></button>)}</div>
          {current && <article className="detail"><div className="detail-top"><span className="eyebrow">{current.id}</span><span className="pill">{taskState[current.status]} · {current.version}</span></div><h2>{current.title}</h2><p>{current.problem}</p><h3>验收不变量</h3><ol>{current.acceptance.map(item => <li key={item}>{item}</li>)}</ol><h3>验证方法</h3><p>{current.oracle}</p><div className="detail-footer"><span>{current.track === 'core' ? '核心题 · 纳入分级总分' : '集成题 · 独立报告'}</span><b>可用 50 + 代码 50</b></div></article>}</div>
        </> : <><section className="section-head"><h2>评分预览 <small>最近 100 条</small></h2><span>输入证据由调用方提供，尚未独立验证</span></section>{!report ? <div className="empty"><h3>还没有评分预览</h3><p>点击“生成示例评分”，查看分数计算与证据展示。</p></div> : <div className="report-layout"><aside className="report-list">{reports.map(item => <button className={item.id === report.id ? 'report-item selected' : 'report-item'} onClick={() => setActiveReport(item.id)} key={item.id}><b>{item.assessment.taskId}</b><strong>{number(item.result.total)} <small>/100</small></strong><span>{new Date(item.createdAt).toLocaleString('zh-CN')}</span></button>)}</aside><article className="detail report-detail"><div className="detail-top"><h2>{report.assessment.taskId} · 评分预览</h2><span className="pill">非正式成绩</span></div><div className="score-hero"><strong>{number(report.result.total)}<small> / 100</small></strong><span>{report.result.thresholdMet === null ? '证据不完整，等待补齐' : report.result.thresholdMet ? '达到预览门槛' : '未达到门槛'}</span></div><div className="score-pair"><div>可用验证 <b>{number(report.result.functional)} / 50</b></div><div>代码质量 <b>{number(report.result.quality)} / 50</b></div></div><h3>代码质量分项</h3>{Object.entries(report.result.dimensions).map(([key, value]) => <div className="metric" key={key}><span>{qualityLabels[key as keyof typeof qualityLabels]}</span><meter min="0" max="100" value={value ?? 0} aria-label={qualityLabels[key as keyof typeof qualityLabels]} /><b>{number(value)}</b></div>)}<h3>证据记录</h3>{report.assessment.evidence.map(item => <div className="evidence" key={item.id}><code>{item.id}</code><p>{item.summary}</p></div>)}{report.result.reasons.map(reason => <p key={reason}>{reason}</p>)}<footer className="report-meta">规则 {report.result.rubricVersion} · {report.id}</footer></article></div>}</>}
        <footer className="page-footer">FOREVER SKYWALKER <span>固定行为契约 · 保留执行证据 · 可复核的评分</span></footer>
      </div>
    </main>
  </div>;
}

const root = document.getElementById('root');
if (!root) throw new Error('缺少应用根节点。');
createRoot(root).render(<StrictMode><App /></StrictMode>);
