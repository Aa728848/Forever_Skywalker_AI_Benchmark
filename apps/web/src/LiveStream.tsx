import { useEffect, useRef, useState } from 'react';

/**
 * 作答中的流式输出面板。
 *
 * 数据来源是 supervisor 追加写入的 launch.log：子进程 stdout 直接接在里面，
 * 所以看到的是作答当时打印的原文，而不是事后根据结果重建的摘要。
 *
 * 三条设计约束：
 * 1. **增量拉取**：服务端按 offset 返回新增字节，面板只追加，不整份重传。
 * 2. **滚动跟随只在不手动上滚时生效**：用户往上翻看时不能被新行顶回去。
 * 3. **日志可能不存在**：刚发起或没有子进程时按空处理，不显示成错误。
 */

const POLL_MS = 2000;
/** 只在内存里保留最近这么多字符：一次全量 16 题的日志会很长，界面上看的是「最近发生了什么」。 */
const MAX_CHARS = 200_000;

export function LiveStream({ launchId, running }: { launchId: string; running: boolean }) {
  const [text, setText] = useState('');
  const [state, setState] = useState<string>('');
  const [failure, setFailure] = useState('');
  const [follow, setFollow] = useState(true);
  const offsetRef = useRef(0);
  const boxRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    offsetRef.current = 0;
    setText('');
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
        if (typeof value.state === 'string') setState(value.state);
        const chunk = typeof value.text === 'string' ? value.text : '';
        if (chunk !== '') setText(previous => {
          const merged = previous + chunk;
          return merged.length > MAX_CHARS ? merged.slice(merged.length - MAX_CHARS) : merged;
        });
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

  // 跟随只有在用户没有手动上滚时生效。
  useEffect(() => {
    const box = boxRef.current;
    if (box !== null && follow) box.scrollTop = box.scrollHeight;
  }, [text, follow]);

  return <div className="live-stream">
    <div className="live-head">
      <b>作答中的实时输出</b>
      <span className={'state-tag ' + (running ? 'ok' : 'idle')}>{running ? '进行中' : (state === '' ? '已结束' : state)}</span>
      <label className="live-follow">
        <input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} />
        自动跟随到底部
      </label>
    </div>
    {failure !== '' && <div className="error" role="alert">{failure}</div>}
    <pre ref={boxRef} className="live-output" aria-live="polite">{text === '' ? '还没有输出。作答开始后，思考与输出片段会实时出现在这里。' : text}</pre>
  </div>;
}
