# PERF-04 · 长会话重放的延迟、吞吐与内存预算

- 难度：极度困难；题型：独立核心题；能力域：性能优化。
- 运行时：TypeScript on Node.js 24（依赖 Node 原生类型剥离，仅可使用可擦除语法）。
- 题目版本：0.2.0；评分规则版本：0.1.0。

## 背景

`starter/` 是一个可独立运行的最小项目，`starter/src/replay.ts` 统计长会话回放结果。
当前实现为每个会话重新扫描整个输入，复杂度退化到 O(会话数 × 事件数)。
请在**不改变公开接口与结果语义**的前提下修复，使实现只对输入做常数次遍历。

## 公开接口（冻结，不得修改签名、导出名与文件路径）

```ts
export interface SessionEvent {
  readonly id: string; readonly at: number;
  readonly kind: 'open' | 'message' | 'close';
  readonly session?: string; readonly payload?: string;
}
export interface SessionSummary {
  readonly sessions: number; readonly messages: number; readonly bytes: number;
  readonly lastAt: number | null;
  readonly longestSession: { readonly id: string; readonly messages: number } | null;
}
export function replaySession(events: readonly SessionEvent[]): SessionSummary;
```

## 必须满足的行为契约

1. `sessions` 是出现过的不同 `session` 数；缺省 `session` 按空串计，id 按精确字符串比较。
2. `messages` 是 `kind === 'message'` 的事件数（不区分会话）。
3. `bytes` 是所有事件 `payload` 的 UTF-8 字节数之和；缺省 `payload` 计 0。
4. `lastAt` 是所有事件 `at` 的最大值；没有事件时为 null。
5. `longestSession` 是消息数最多的会话；并列时取 id 字典序最小者；没有任何消息时为 null。
6. **复杂度**：对输入的元素访问总次数必须是 O(n)。检查会用可计数的输入观察访问次数，公开常数是 ≤ 8n。
7. 不得修改输入；同一输入重复调用结果一致；结果必须与朴素差分参考实现完全一致。

## 真实性能证据（0.2.0）

- 最低资源检查保留 5,000 条事件、2 次预热后的 7 次原始耗时/RSS/堆内存样本及中位数，不能只保留最好一轮。它的宽松终止上限不等同于性能质量分。
- 独立受信工作负载为 32,000 条事件、2,000 个会话，每次 12 轮完整摘要计算，包含 UTF-8 payload、负时间戳及并列会话排序；每轮都校验结果语义。
- 正式效率证据由平台在同一固定环境交替运行参考和候选：预热至少 2 轮、测量至少 7 对，记录全部原始样本、环境哈希、比值中位数与离散度。
- 候选同进程返回的耗时、吞吐与 RSS 只能作为诊断；评分使用外部受信计时与资源采样。阈值未校准时只报告演练结果，不能据此宣称正式性能成绩。

## 限制

- 答案范围限于 `starter/`；不要修改 `public-tests/`。
- 不得引入第三方运行时依赖。
- 只能使用可擦除的 TypeScript 语法：不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

在**工作区根目录**运行：

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

公开检查里已经包含复杂度断言（用访问计数而不是计时）；正式判定还会在冻结快照上追加更大规模与更多会话分布。

## 判定

- 参考实现通过全部公开与未公开检查。
- 注入目标缺陷的起始版本必须被检出（失败项限于预先声明的检出项），其余已正确行为不得回归。
- 与参考实现结构不同的替代实现也必须通过同一契约。
- 本阶段只产出检查通过或失败；代码质量评审接入前总分保持待定。
