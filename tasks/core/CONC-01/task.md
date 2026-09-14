# CONC-01 · 取消与超时传播

- 难度：简单；题型：独立核心题；能力域：异步并发。运行时：TypeScript on Node.js 24。题目版本：0.1.0。

## 背景

`starter/src/cancelable.ts` 把一段异步工作包成可取消任务。当前实现的取消与超时都只结算 Promise，
**没有 abort signal**，成功结算后也不取消定时器（泄漏）。请在**不改变公开接口**的前提下修复。

## 公开接口（冻结）

```ts
export interface TimerHandle { cancel(): void }
export interface Scheduler { after(delayMs: number, run: () => void): TimerHandle }
export interface CancelableTask<T> { readonly promise: Promise<T>; cancel(): void }
export class CancelledError extends Error {}
export class TimeoutError extends Error {}
export function runCancelable<T>(work: (signal: AbortSignal) => Promise<T>, options: { scheduler: Scheduler; timeoutMs?: number }): CancelableTask<T>;
```

## 必须满足的行为契约

1. 工作成功时 `promise` 用其结果兑现；工作抛错（同步或异步）时以该错误拒绝，绝不向调用方同步抛出。
2. `cancel()` 必须先 `abort` 传给工作的 signal，再以 `CancelledError` 拒绝；重复 `cancel()` 幂等。
3. `timeoutMs` 缺省 30000；到期未结算时同样先 `abort` signal，再以 `TimeoutError` 拒绝。
4. 无论成功、失败、取消还是超时，结算之后都不得留下存活的定时器（`TimerHandle.cancel()` 必须被调用）。
5. Promise 只结算一次：结算之后再调用 `cancel()` 或触发超时都不得改变结果。

注入的 Scheduler.after 先返回 TimerHandle，回调之后才可能触发；after 和 TimerHandle.cancel 本身不抛异常。本题不把调度器实现故障与被测异步工作的失败混为一类。

## 限制

- 只改 `starter/`；不得引入第三方依赖、不得使用真实计时器（时间行为只通过注入的 `Scheduler`）；
  不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

## 判定

- 参考实现通过全部公开与未公开检查；缺陷起始版本只被声明的检出项判失败；替代实现同样通过。
- 本阶段产出检查结论与可用验证分；代码质量评审接入前总分保持待定。
