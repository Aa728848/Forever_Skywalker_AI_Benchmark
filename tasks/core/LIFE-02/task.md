# LIFE-02 · 流结束、超时和迟到回调

- 难度：中等；题型：独立核心题；能力域：生命周期。运行时：TypeScript on Node.js 24。题目版本：0.1.0。

## 背景

`starter/src/stream.ts` 收集流式事件并给出汇总。流有**终态**（正常结束、出错、超时），
终态之后到达的任何事件都是迟到的取消/回调，**不得再改变结果**。当前实现完全没有终态概念：
结束之后的数据照旧累加，出错之后还能被新错误覆盖，超时也不冻结。请在**不改变公开接口**的前提下修复。

## 公开接口（冻结）

```ts
export type StreamEvent =
  | { readonly kind: 'data'; readonly value: number }
  | { readonly kind: 'end' }
  | { readonly kind: 'error'; readonly message: string };
export interface StreamSummary { readonly total: number; readonly count: number; readonly ended: boolean; readonly error: string | null }
export interface CollectorOptions { readonly timeoutMs?: number }
export class StreamCollector {
  constructor(options?: CollectorOptions);
  push(event: StreamEvent): void;
  timeout(): void;
  get timeoutMs(): number;
  get summary(): StreamSummary;
}
```

## 必须满足的行为契约

1. `data` 累加 `total` 与 `count`；`total` 只累加 `value`。
2. 三种终态：`end`（`ended` 为 true）、`error`（保留**第一条**错误消息）、`timeout()`（`error` 为 `'超时'`）。
3. 进入终态后，后续任何 `push`（含 `data`/`end`/`error`）与 `timeout()` 一律忽略，汇总不再改变。
4. `timeout()` 幂等：第二次调用不改变任何字段。
5. `summary` 是**快照**：取出的对象不随后续 `push` 改变。
6. `timeoutMs` 缺省 5000，由构造参数提供，只作为配置读出（本阶段不引入真实计时器）。

## 限制

- 只改 `starter/`；不得引入第三方依赖；不得使用真实计时器；不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

## 判定

- 参考实现通过全部公开与未公开检查；缺陷起始版本只被声明的检出项判失败；替代实现同样通过。
- 本阶段产出检查结论与可用验证分；代码质量评审接入前总分保持待定。
