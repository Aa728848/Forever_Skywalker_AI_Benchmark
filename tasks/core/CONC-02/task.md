# CONC-02 · 任务组的取消传播

- 难度：中等；题型：独立核心题；能力域：异步并发。运行时：TypeScript on Node.js 24。题目版本：0.1.0。

## 背景

`starter/src/group.ts` 把若干成员任务收进一个组。当前实现的 `cancelAll()` 只把错误塞给成员：
**既不 abort signal，也不清理 `active`，用普通 `Error` 而不是 `GroupCancelledError` 拒绝，并且不等待成员真正结算**。
请在**不改变公开接口**的前提下修复。

## 公开接口（冻结）

```ts
export class GroupCancelledError extends Error { readonly pending: readonly string[] }
export class TaskGroup {
  get active(): readonly string[];
  run<T>(id: string, work: (signal: AbortSignal) => Promise<T>): Promise<T>;
  cancelAll(): Promise<void>;
}
```

## 必须满足的行为契约

1. `active` 只包含尚未结算的成员 id，按启动顺序；成员成功或失败后都必须立刻消失。
2. 成员结果原样兑现；成员自身抛错只影响它自己，不影响其它成员。
3. `cancelAll()` 必须：① 对每个未完成成员调用 `signal.abort()`；② 用 `GroupCancelledError` 拒绝它们的 promise，
   且 `pending` 为本次被取消成员的 id 列表；③ 清空 `active`；④ **在所有成员真正结算之后**才兑现。
4. 没有未完成成员时 `cancelAll()` 是空操作：不 abort 任何 signal，立即兑现。

## 限制

- 只改 `starter/`；不得引入第三方依赖；不得使用真实计时器；不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

## 判定

- 参考实现通过全部公开与未公开检查；缺陷起始版本只被声明的检出项判失败；替代实现同样通过。
- 本阶段产出检查结论与可用验证分；代码质量评审接入前总分保持待定。
