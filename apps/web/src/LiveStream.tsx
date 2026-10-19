import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, X } from 'lucide-react';
import { applyStreamLines, emptyLiveStreams, splitFields, splitLogChunk } from './liveStream.ts';
import type { LiveAnswer, LiveAnswerState, LiveEvent, LiveStreams } from './liveStream.ts';

/**
 * 作答中的流式输出面板：**每条作答一个框**。
 *
 * 数据来源是 supervisor 追加写入的 launch.log：子进程 stdout 直接接在里面，
 * 所以看到的是作答当时打印的原文，而不是事后根据结果重建的摘要。
 *
 * 四条设计约束：
 * 1. **增量拉取**：服务端按 offset 返回新增字节，面板只追加，不整份重传。
 * 2. **按作答分框**：并发时多条作答的行交错在同一份日志里，靠行首身份拆进各自的框；
 *    三路并发就是三个框，每排最多两个，多出来的往下排。
 * 3. **滚动跟随只在不手动上滚时生效**：用户往上翻看时不能被新行顶回去（每个框独立判断）。
 * 4. **日志可能不存在**：刚发起或没有子进程时按空处理，不显示成错误。
 */

const POLL_MS = 2000;
/** 只在内存里保留最近这么多字符：一次全量 55 题的日志会很长，界面上看的是「最近发生了什么」。 */
const MAX_CHARS = 200_000;
/** 单个框最多显示多少条：并发的框要能一眼看完，不是无限长的滚动条。 */
const BOX_EVENT_LIMIT = 120;
/** 全屏视图里每个作答最多显示多少条。 */
const OVERLAY_EVENT_LIMIT = 600;
/** 框内正文的显示上限：超出就折叠，点开看全文。 */
const TEXT_LIMIT = 400;
const TOOL_LIMIT = 160;
const RESULT_LIMIT = 220;

const stateLabels: Record<LiveAnswerState, string> = { running: '进行中', done: '已完成', failed: '失败', stopped: '已中止' };
const stateKinds: Record<LiveAnswerState, string> = { running: 'ok', done: 'idle', failed: 'bad', stopped: 'warn' };

/** 截断后仍可展开：默认收起，点一下看全文（不额外请求数据）。 */
function Expandable({ text, limit }: { text: string; limit: number }) {
  const [expanded, setExpanded] = useState(false);
  const truncated = text.length > limit;
  const shown = expanded || !truncated ? text : text.slice(0, limit) + '…';
  return <>
    <span className="live-text-body">{shown}</span>
    {truncated
      ? <button type="button" className="link live-more" onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : '展开全文'}</button>
      : null}
  </>;
}

/** 一条事件：按类型分色。阶段是分隔条，工具调用与工具结果各自成行。 */
function LiveLine({ event }: { event: LiveEvent }) {
  if (event.kind === 'phase') return <p className="live-line live-phase">{event.payload}</p>;
  if (event.kind === 'end') return <p className="live-line live-end">本轮结束：{event.payload}</p>;
  if (event.kind === 'tool') {
    const [name, args] = splitFields(event.payload);
    return <p className="live-line live-tool">
      <b>{name}</b>
      {args !== undefined && args !== '' ? <span className="live-args"><Expandable text={args} limit={TOOL_LIMIT} /></span> : null}
    </p>;
  }
  if (event.kind === 'result') {
    const [status, name, summary] = splitFields(event.payload);
    const failed = status === 'err';
    return <p className={'live-line live-result ' + (failed ? 'bad' : 'ok')}>
      <b>{name}</b>
      <span className="live-result-status">{failed ? '失败' : '完成'}</span>
      {summary !== undefined && summary !== '' ? <span className="live-result-text"><Expandable text={summary} limit={RESULT_LIMIT} /></span> : null}
    </p>;
  }
  return <p className={'live-line ' + (event.kind === 'think' ? 'live-think' : 'live-text')}>
    <Expandable text={event.payload} limit={TEXT_LIMIT} />
  </p>;
}

/** 一条作答的框。 */
function AnswerBox({ answer, follow, limit, focused }: { answer: LiveAnswer; follow: boolean; limit: number; focused: boolean }) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // 用户一旦上滚，这个框就不再自动跟随；回到底部才恢复。
  const stickRef = useRef(true);
  const events = answer.events.length > limit ? answer.events.slice(-limit) : answer.events;
  useEffect(() => {
    const box = bodyRef.current;
    if (box === null || !follow || !stickRef.current) return;
    box.scrollTop = box.scrollHeight;
  }, [events.length, follow]);
  const onScroll = () => {
    const box = bodyRef.current;
    if (box === null) return;
    stickRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
  };
  const identity = answer.identity;
  return <section
    className={'live-box' + (focused ? ' focused' : '')}
    aria-label={identity.taskId + ' ' + identity.preset + '/' + identity.mode + ' 第' + identity.repetition + ' 次的作答输出'}
  >
    <header className="live-box-head">
      <b>{identity.taskId}</b>
      <span className="live-box-meta">{identity.preset}/{identity.mode} · 第{identity.repetition}次</span>
      <span className={'state-tag ' + stateKinds[answer.state]}>{stateLabels[answer.state]}</span>
    </header>
    {answer.phase !== '' ? <p className="live-box-phase">{answer.phase}</p> : null}
    <div className="live-box-body" ref={bodyRef} onScroll={onScroll} aria-live="polite">
      {events.length === 0
        ? <p className="live-line live-text">还没有输出。</p>
        : events.map((event, index) => <LiveLine key={index} event={event} />)}
    </div>
    {answer.events.length > limit
      ? <p className="live-box-more">仅显示最近 {limit} 条（共 {answer.events.length} 条），完整过程见「全部输出」。</p>
      : null}
  </section>;
}

/** 全屏覆盖层：所有作答都在这里（每排最多两个），可从摘要条直接跳到某一条。 */
function StreamOverlay({ streams, focus, follow, onClose }: {
  streams: LiveStreams;
  focus: string | null;
  follow: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, []);
  return <div className="live-overlay" role="dialog" aria-modal="true" aria-label="全部输出">
    <div className="live-overlay-head">
      <b>全部输出</b>
      <span>{streams.answers.length} 条作答</span>
      <button className="secondary" onClick={onClose}><X size={13} aria-hidden="true" />关闭</button>
    </div>
    <div className="live-grid">
      {streams.answers.map(answer => <AnswerBox key={answer.key} answer={answer} follow={follow} limit={OVERLAY_EVENT_LIMIT} focused={focus === answer.key} />)}
    </div>
  </div>;
}

export function LiveStream({ launchId, running }: { launchId: string; running: boolean }) {
  const [raw, setRaw] = useState('');
  const [rawLines, setRawLines] = useState(0);
  const [streams, setStreams] = useState<LiveStreams>(emptyLiveStreams);
  const [failure, setFailure] = useState('');
  const [follow, setFollow] = useState(true);
  // null = 未打开；focus = 聚焦到某条作答（null 表示只看全部）。
  const [overlay, setOverlay] = useState<{ focus: string | null } | null>(null);
  const offsetRef = useRef(0);
  const pendingRef = useRef('');

  useEffect(() => {
    offsetRef.current = 0;
    pendingRef.current = '';
    setRaw('');
    setRawLines(0);
    setStreams(emptyLiveStreams);
    setFailure('');
  }, [launchId]);

  useEffect(() => {
    if (launchId === '') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const response = await fetch('/api/experiments/' + encodeURIComponent(launchId) + '/stream?offset=' + offsetRef.current);
        if (!response.ok) throw new Error('读取实时输出失败（' + response.status + '）。');
        const value = await response.json() as { offset?: number; text?: string; state?: string };
        if (cancelled) return;
        if (typeof value.offset === 'number') offsetRef.current = value.offset;
        const chunk = typeof value.text === 'string' ? value.text : '';
        if (chunk !== '') {
          // 服务端按 64KB 切片，切口可能落在行中间：半行留到下一轮再拼。
          const { lines, rest } = splitLogChunk(pendingRef.current, chunk);
          pendingRef.current = rest;
          setRaw(previous => {
            const merged = previous + chunk;
            return merged.length > MAX_CHARS ? merged.slice(merged.length - MAX_CHARS) : merged;
          });
          setRawLines(previous => previous + lines.length);
          setStreams(previous => applyStreamLines(previous, lines));
        }
        setFailure('');
      } catch (cause) {
        if (!cancelled) setFailure(cause instanceof Error ? cause.message : '读取实时输出失败。');
      } finally {
        if (!cancelled) timer = setTimeout(() => void tick(), POLL_MS);
      }
    };
    void tick();
    return () => { cancelled = true; if (timer !== undefined) clearTimeout(timer); };
  }, [launchId, running]);

  const active = streams.answers.filter(answer => answer.state === 'running');
  const finished = streams.answers.filter(answer => answer.state !== 'running');

  return <div className="live-stream">
    <div className="live-head">
      <b>作答中的实时输出</b>
      <span className={'state-tag ' + (running ? 'ok' : 'idle')}>{running ? '进行中' : '已结束'}</span>
      <div className="live-tools">
        <label className="live-follow">
          <input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} />
          自动跟随到底部
        </label>
        <button className="secondary" disabled={streams.answers.length === 0} onClick={() => setOverlay({ focus: null })}>
          <Maximize2 size={13} aria-hidden="true" />全部输出
        </button>
      </div>
    </div>
    {failure !== '' && <div className="error" role="alert">{failure}</div>}
    {streams.answers.length === 0
      ? <div className="empty">还没有输出。作答开始后，每条作答的阶段、输出、工具调用与结果会实时出现在各自的框里。</div>
      : <>
        {active.length > 0
          ? <div className="live-grid">{active.map(answer => <AnswerBox key={answer.key} answer={answer} follow={follow} limit={BOX_EVENT_LIMIT} focused={false} />)}</div>
          : null}
        {finished.length > 0
          ? <div className="live-finished">
            <h4>已结束的作答 <small>{finished.length} 条</small></h4>
            <div className="live-summary-list">
              {finished.map(answer => <button key={answer.key} className="live-summary" onClick={() => setOverlay({ focus: answer.key })}>
                <b>{answer.identity.taskId}</b>
                <span>{answer.identity.preset}/{answer.identity.mode} · 第{answer.identity.repetition}次</span>
                <span className={'state-tag ' + stateKinds[answer.state]}>{stateLabels[answer.state]}</span>
                <span className="live-summary-count">{answer.events.length} 条</span>
              </button>)}
            </div>
          </div>
          : null}
      </>}
    <details className="live-raw">
      <summary>原始日志 <small>{rawLines} 行</small></summary>
      <pre className="live-output">{raw === '' ? '还没有输出。' : raw}</pre>
    </details>
    {/* 覆盖层挂到 body 上：外层 .detail 带 transform 动画，fixed 定位会被它当包含块。 */}
    {overlay !== null && typeof document !== 'undefined'
      ? createPortal(
        <StreamOverlay streams={streams} focus={overlay.focus} follow={follow} onClose={() => setOverlay(null)} />,
        document.body)
      : null}
  </div>;
}
