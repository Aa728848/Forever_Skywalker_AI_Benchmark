# LIFE-01 · 订阅与定时器释放

- 难度：简单；题型：独立核心题；能力域：生命周期。运行时：TypeScript on Node.js 24。题目版本：0.1.0。

## 背景

`starter/src/poller.ts` 用注入的调度器做周期任务。当前实现 `stop()` 不取消定时器（泄漏），
重复 `start()` 会创建多个定时器（重复订阅）。请在**不改变公开接口**的前提下修复。

## 公开接口（冻结）

```ts
export interface Timer { cancel(): void }
export interface Scheduler { every(intervalMs: number, run: () => void): Timer }
export class Poller {
  constructor(tick: () => void, scheduler: Scheduler, intervalMs?: number);
  get running(): boolean;
  get activeTimers(): number;
  start(): void;
  stop(): void;
}
```

## 必须满足的行为契约

1. `start()` 创建**恰好一个**定时器并置 `running = true`；重复调用不得创建第二个定时器，也不得重复触发。
2. `stop()` 必须取消已创建的定时器（`Timer.cancel()` 被调用）并把 `activeTimers` 归零；之后不得再触发。
3. 未启动就 `stop()` 是安全的空操作，不创建也不取消失效定时器。
4. `stop()` 之后可以再次 `start()`，新的定时器是独立的。
5. 构造参数缺省时使用 1000ms。
6. 不得使用真实计时器，一切时间行为通过注入的 `Scheduler`。

## 限制

- 只改 `starter/`；不得引入第三方依赖；不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

## 判定

- 参考实现通过全部公开与未公开检查；缺陷起始版本只被声明的检出项判失败；替代实现同样通过。
- 本阶段产出检查结论与可用验证分；代码质量评审接入前总分保持待定。
