import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity, ArrowRight, Boxes, Diamond, FileText, LayoutGrid, ListChecks, Play, Settings,
} from 'lucide-react';
import { difficultyLabels, tasksValidator, type Task } from '@fsa/contracts';
import './design.css';
import { RunPanel } from './RunPanel.tsx';
import { ReportCenter } from './ReportCenter.tsx';
import { ConfigPanel } from './ConfigPanel.tsx';
import { LaunchPanel } from './LaunchPanel.tsx';

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error(`请求失败（${response.status}），请检查 API 服务并重试。`);
  return response.json() as Promise<unknown>;
}

type Tab = 'catalog' | 'runs' | 'experiments' | 'launch' | 'config';

/** 导航项：图标一律 Lucide，含义写在 aria-label 与浮出提示里，不靠符号字形。 */
const navigation: ReadonlyArray<{ id: Tab; label: string; icon: typeof LayoutGrid; heading: string; lead: string }> = [
  { id: 'catalog', label: '题目目录', icon: LayoutGrid, heading: '让工程能力，经得起验证。', lead: '从七个真实项目提炼的工程任务：固定契约、隐藏检查、可复核的执行证据。' },
  { id: 'runs', label: '提交与记录', icon: ListChecks, heading: '每一次作答，都留下证据。', lead: '冻结候选快照，受控执行公开与隐藏检查，按结果给出可用验证分。' },
  { id: 'experiments', label: '报告中心', icon: FileText, heading: '每一项结论，都有据可查。', lead: '自动测评落盘的实验报告：逐条作答、标准通过情况、证据产物。' },
  { id: 'launch', label: '发起测评', icon: Play, heading: '发起一次可复核的自动测评。', lead: '选择题目、预设与思考等级，由受控 supervisor 托管整轮作答。' },
  { id: 'config', label: '配置', icon: Settings, heading: '每一次运行，都按你的配置。', lead: '运行档案、裁判模型与访问令牌。保存后即时生效，不需重启。' },
];

function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [tab, setTab] = useState<Tab>('catalog');
  const [difficulty, setDifficulty] = useState('all');
  const [domain, setDomain] = useState('all');
  const [track, setTrack] = useState('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [experiments, setExperiments] = useState(0);
  const countExperiments = useCallback((count: number) => setExperiments(count), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void request('/api/tasks', { signal: controller.signal })
      .then((taskData) => {
        if (!tasksValidator.Check(taskData)) throw new Error('题库协议不匹配。');
        setTasks(taskData);
      }).catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '加载失败。'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);

  const filtered = tasks.filter(task =>
    (difficulty === 'all' || task.difficulty === difficulty) && (domain === 'all' || task.domain === domain) && (track === 'all' || task.track === track)
    && `${task.id} ${task.title} ${task.sources.join(' ')}`.toLowerCase().includes(search.toLowerCase()));
  const current = filtered.find(task => task.id === selected) ?? filtered[0];
  const packaged = tasks.filter(task => task.status !== 'designed').length;
  const coreCount = tasks.filter(task => task.track === 'core').length;
  const integrationCount = tasks.filter(task => task.track === 'integration').length;
  const taskState = { designed: '设计规格', 'fixture-ready': '题目包已验证', calibrating: '校准中', ready: '已发布' } as const;
  const active = navigation.find(item => item.id === tab) ?? navigation[0]!;

  return <div className="shell">
    <aside className="sidebar">
      <a className="brand" href="/" aria-label="Forever Skywalker 首页">
        <span className="brand-mark">F</span>
      </a>
      <nav aria-label="主导航">
        {navigation.map(item => {
          const Icon = item.icon;
          return <button key={item.id} className={tab === item.id ? 'nav active' : 'nav'} data-label={item.label}
            aria-label={item.label} aria-current={tab === item.id ? 'page' : undefined} onClick={() => setTab(item.id)}>
            <Icon aria-hidden="true" />
            {item.id === 'catalog' && tasks.length > 0 && <small>{tasks.length}</small>}
            {item.id === 'experiments' && experiments > 0 && <small>{experiments}</small>}
          </button>;
        })}
      </nav>
      <div className="side-footer"><span className="status-dot" aria-hidden="true" />{packaged}/{tasks.length || 0}</div>
    </aside>

    <main>
      <header className="topbar">
        <Activity size={14} aria-hidden="true" />
        <span>工作台<span className="slash">/</span>{active.label}</span>
        <span className="pill">本地工作区</span>
      </header>
      <div className="content">
        <section className="heading">
          <div className="eyebrow">Forever Skywalker / Benchmark</div>
          <h1>{active.heading}</h1>
          <p>{active.lead}</p>
        </section>

        {tab === 'catalog' && !loading && <div className="notice">
          <b>{packaged} / {tasks.length} 题目包已验证</b>
          <span>难度按实测通过率分层，尚未经真实模型校准。缺少客观或评审证据时总分保持待定。</span>
        </div>}

        {error && <div className="error" role="alert">{error} <button className="link" onClick={() => setReload(value => value + 1)}>重新加载</button></div>}

        {tab === 'catalog' && !loading && <section className="stats" aria-label="题库概况">
          {[
            [String(tasks.length), '设计题目', '来自 7 个真实项目'],
            [String(coreCount), '核心题目', '12 个能力域各一道深度题'],
            [String(integrationCount), '原仓库集成题', '独立报告 · 固定源码版本'],
            ['50 / 50', '评分比例', '可用验证 / 代码质量'],
          ].map(([value, label, caption]) => <article key={label}>
            <span>{label}</span><strong>{value}</strong><small>{caption}</small>
          </article>)}
        </section>}

        {loading && tab !== 'config' && tab !== 'launch' ? <div className="empty" role="status">正在加载题库与报告…</div>
          : tab === 'config' ? <ConfigPanel />
          : tab === 'launch' ? <LaunchPanel tasks={tasks} />
          : tab === 'runs' ? <RunPanel tasks={tasks} />
          : tab === 'experiments' ? <ReportCenter onCount={countExperiments} />
          : tab === 'catalog' ? <>
            <section className="section-head"><h2>题目目录 <small>{filtered.length} 道</small></h2><span>按难度分层</span></section>
            <div className="filters">
              <input aria-label="搜索题目" placeholder="搜索题目、编号或来源项目…" value={search} onChange={event => setSearch(event.target.value)} />
              <select aria-label="难度" value={difficulty} onChange={event => setDifficulty(event.target.value)}>
                <option value="all">全部难度</option>
                {Object.entries(difficultyLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
              <select aria-label="能力域" value={domain} onChange={event => setDomain(event.target.value)}>
                <option value="all">全部能力域</option>
                {[...new Set(tasks.map(task => task.domain))].map(value => <option key={value}>{value}</option>)}
              </select>
              <select aria-label="题型" value={track} onChange={event => setTrack(event.target.value)}>
                <option value="all">全部题型</option><option value="core">核心题</option><option value="integration">集成题</option>
              </select>
            </div>
            <div className="catalog-grid">
              <div className="task-list">
                {filtered.length === 0 ? <div className="empty">没有符合筛选条件的题目。</div> : filtered.map(task => {
                  const Icon = task.track === 'core' ? Diamond : Boxes;
                  return <button key={task.id} aria-pressed={current?.id === task.id}
                    className={`task-row ${current?.id === task.id ? 'selected' : ''}`} onClick={() => setSelected(task.id)}>
                    <span className="task-icon"><Icon aria-hidden="true" /></span>
                    <span className="task-name">
                      <span className="task-id">{task.id} · {task.domain}</span>
                      <b>{task.title}</b>
                      <small>{task.sources.join(' / ')}</small>
                    </span>
                    <span className={`badge ${task.difficulty}`}>{difficultyLabels[task.difficulty]}</span>
                    <ArrowRight className="arrow" size={15} aria-hidden="true" />
                  </button>;
                })}
              </div>
              {current && <article className="detail">
                <div className="detail-top">
                  <span className="eyebrow">{current.id}</span>
                  <span className="pill">{taskState[current.status]} · {current.version}</span>
                </div>
                <h2>{current.title}</h2>
                <p>{current.problem}</p>
                <h3>验收不变量</h3>
                <ol>{current.acceptance.map(item => <li key={item}>{item}</li>)}</ol>
                <h3>验证方法</h3>
                <p>{current.oracle}</p>
                <div className="detail-footer">
                  <span>{current.track === 'core' ? '核心题 · 纳入分级总分' : '集成题 · 独立报告'}</span>
                  <b>可用 50 + 代码 50</b>
                </div>
              </article>}
            </div>
          </> : null}

        <footer className="page-footer">
          Forever Skywalker <span>固定行为契约 · 保留执行证据 · 可复核的评分</span>
        </footer>
      </div>
    </main>
  </div>;
}

const root = document.getElementById('root');
if (!root) throw new Error('缺少应用根节点。');
createRoot(root).render(<StrictMode><App /></StrictMode>);
