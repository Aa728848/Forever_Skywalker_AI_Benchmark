import { useState } from 'react';
import type { ProgressEntry } from '@fsa/contracts';

/**
 * 进度日志：一份实验最多记 500 条（见 comparisonProgressLimit），默认全展开会把报告详情
 * 整页撑走，真正要看的「逐条作答」表被挤到很远。
 *
 * 两条约束决定了这个组件的写法：
 *
 * 1. **默认收起**（超过 8 条时），条数少的直接展开——那时收起比展开更麻烦。
 * 2. **收起时根本不挂载 <ol>**，而不只是用 CSS 藏起来。进行中的实验每 5 秒刷新一次，
 *    几百个 DOM 节点每轮重建是不必要的开销。
 *
 * <details> 的 open 属性是「非受控」的：由用户点击改变。若同时用 open={state} 接管，
 * 两边会互相覆盖（React 认为状态没变，浏览器认为变了）。因此只读 DOM 的 open 作为唯一事实，
 * 组件状态只用来决定「要不要渲染 <ol>」——两者同向，不存在冲突。
 */
const expandedByDefault = 8;

const time = (value: string) => value === '' ? '未登记' : new Date(value).toLocaleString('zh-CN');

export function ProgressLog({ entries }: { entries: ProgressEntry[] }) {
  // 切换实验时重新判定默认展开：用调用方的 key 触发重挂载，而不是 effect 复位。
  const [open, setOpen] = useState(entries.length <= expandedByDefault);
  if (entries.length === 0) {
    return <div className="empty">该实验未记录进度日志（0.2.0 报告没有该字段）。</div>;
  }
  return (
    <details
      className="progress-log"
      open={open}
      onToggle={event => setOpen(event.currentTarget.open)}
    >
      {/* 提示只在收起时出现：展开状态下 summary 左侧的三角已经说明「可点收」。 */}
      <summary>进度日志 <small>{entries.length} 条</small><span className="progress-log-hint">点击展开</span></summary>
      {open ? (
        <ol className="timeline">{entries.map((entry, index) => (
          <li key={entry.at + '-' + index}><b>{entry.message}</b><time>{time(entry.at)}</time></li>
        ))}</ol>
      ) : null}
    </details>
  );
}
