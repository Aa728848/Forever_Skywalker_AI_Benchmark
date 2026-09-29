import { useCallback, useEffect, useMemo, useState } from 'react';
import { readToken, useBenchToken, writeToken } from './token.ts';

/**
 * 外部作答提交：候选来自提交根（BENCH_SUBMISSIONS_DIR）下的子目录，提交复用既有的
 * 冻结与可用验证链路（POST /api/submissions → /api/runs），不在这里另写一套。
 *
 * 为什么和「提交与记录」页签在一起：提交成功后，唯一能看到它执行细节与得分的地方
 * 就是运行记录。原先把提交放在「发起测评」页签底部，用户提交完再翻到别处查，
 * 常常以为提交没生效——它其实已经落进运行记录了。
 */
export interface SubmissionTask { id: string; status: string }

const reasonOptions = [['agent-completed', '外部 Agent 已完成'], ['operator-submit', '操作者提交'], ['patch-import', '补丁导入']] as const;

interface Candidate { name: string; files: number }

export function SubmitExternalAnswer({ tasks }: { tasks: SubmissionTask[] }) {
  const [candidates, setCandidates] = useState<{ root: string | null; candidates: Candidate[]; truncated: boolean; warning: string | null } | null>(null);
  const [form, setForm] = useState({ candidateDirectory: '', taskId: 'CACHE-02', idempotencyKey: '', reason: 'agent-completed', measure: false });
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { token, setToken } = useBenchToken();

  useEffect(() => { setToken(readToken()); }, []);
  const headers = useMemo(() => ({ 'content-type': 'application/json', 'x-bench-token': token }), [token]);
  const selectable = tasks.filter(task => task.status !== 'designed');

  const reload = useCallback(() => {
    void fetch('/api/submissions').then(async response => {
      setCandidates(response.ok
        ? await response.json() as { root: string | null; candidates: Candidate[]; truncated: boolean; warning: string | null }
        : { root: null, candidates: [], truncated: false, warning: '提交候选读取失败（' + response.status + '）。' });
    }).catch(() => { setCandidates({ root: null, candidates: [], truncated: false, warning: '提交候选读取失败（网络错误）。' }); });
  }, []);
  useEffect(reload, [reload]);

  async function submit() {
    setBusy(true); setError(''); setResult('');
    try {
      const response = await fetch('/api/submissions', { method: 'POST', headers, body: JSON.stringify({
        taskId: form.taskId, candidateDirectory: form.candidateDirectory,
        idempotencyKey: form.idempotencyKey, submittedBy: 'web-operator', reason: form.reason, measure: form.measure,
      }) });
      if (response.status === 401) { setToken(''); writeToken(''); throw new Error('提交需要有效令牌。'); }
      if (!response.ok) {
        const value = await response.json().catch(() => null);
        const message = typeof value === 'object' && value !== null && 'error' in value ? String((value as { error: unknown }).error) : '服务端未给出原因。';
        throw new Error(message);
      }
      const value = await response.json() as { runId: string; attemptId: string; phase: string; classification: string | null };
      setResult('已提交并完成可用验证：' + value.runId + '/' + value.attemptId + ' · 阶段 ' + value.phase
        + ' · 结论 ' + (value.classification ?? '未评分') + '。它在左边「运行记录」里，下面可查执行明细与证据。');
      reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '提交失败。'); }
    finally { setBusy(false); }
  }

  return <section className="submit-block">
    <h3>提交外部作答</h3>
    <p>候选来自提交根（<code>BENCH_SUBMISSIONS_DIR</code>）下的子目录；提交复用既有的冻结与可用验证链路，不在这里另写一套。</p>
    {candidates !== null && candidates.root === null && <div className="warn" role="status">提交入口未启用：未配置 <code>BENCH_SUBMISSIONS_DIR</code>，或该目录不可读。在「配置」页签填好后这里会出现候选。</div>}
    <div className="token-bar">
      <label htmlFor="submit-token">运行令牌</label>
      <input id="submit-token" type="password" value={token} placeholder="BENCH_RUN_TOKEN" onChange={event => setToken(event.target.value)} />
      <span>与其它页签共用本地缓存；只写入请求头 x-bench-token。</span>
    </div>
    <div className="launch-grid">
      <div className="launch-field">
        <label htmlFor="submission-candidate">候选目录</label>
        <select id="submission-candidate" value={form.candidateDirectory} onChange={event => setForm(current => ({ ...current, candidateDirectory: event.target.value }))}>
          <option value="">请选择…</option>
          {(candidates?.candidates ?? []).map(item => <option key={item.name} value={item.name}>{item.name}（{item.files} 项）</option>)}
        </select>
        {candidates?.warning && <small>{candidates.warning}</small>}
        {candidates?.truncated && <small>候选较多，只列出前 200 条。</small>}
      </div>
      <div className="launch-field">
        <label htmlFor="submission-task">题目</label>
        <select id="submission-task" value={form.taskId} onChange={event => setForm(current => ({ ...current, taskId: event.target.value }))}>
          {selectable.map(task => <option key={task.id} value={task.id}>{task.id}</option>)}
        </select>
        <label htmlFor="submission-key">幂等键（8–200 位字母数字与 _ . : -）</label>
        <input id="submission-key" value={form.idempotencyKey} placeholder="external-2026-09-14-0001" onChange={event => setForm(current => ({ ...current, idempotencyKey: event.target.value }))} />
      </div>
      <div className="launch-field">
        <label htmlFor="submission-reason">提交原因</label>
        <select id="submission-reason" value={form.reason} onChange={event => setForm(current => ({ ...current, reason: event.target.value }))}>
          {reasonOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <label className="launch-inline"><input type="checkbox" checked={form.measure} onChange={event => setForm(current => ({ ...current, measure: event.target.checked }))} /> 本次启用性能测量</label>
        <button className="secondary" disabled={busy || form.candidateDirectory === '' || form.idempotencyKey.length < 8} onClick={() => void submit()}>提交外部作答</button>
      </div>
    </div>
    {error && <div className="error" role="alert">{error}</div>}
    {result && <div className="notice-inline" role="status">{result}</div>}
  </section>;
}
