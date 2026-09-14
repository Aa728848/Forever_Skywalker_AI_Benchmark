# CONC-02 · 并发令牌刷新与注销竞争

- 难度：中等；题型：独立核心题；能力域：异步并发。运行时：TypeScript on Node.js 24。题目版本：0.2.0。

0.1.1 补齐目录要求的令牌刷新/注销场景，并保留 0.1.0 的 TaskGroup 接口和回归行为。

## 令牌刷新契约

`starter/src/token-session.ts` 导出 `TokenSession`、`Tokens`、`RefreshedTokens`、`RefreshPort` 和 `SignedOutError`。构造函数接收初始令牌与异步刷新函数；`current` 返回当前凭据快照，`refresh()` 返回刷新后的 `Tokens`，`logout()` 注销。

1. 同一实例同时刷新只调用一次 RefreshPort，所有调用者取得同一次结果或错误。
2. `logout()` 立即清空凭据；在途刷新随后成功也必须拒绝为 SignedOutError，不能复活身份。
3. 已注销的实例不能再次调用刷新端口。
4. 端口未返回 refreshToken 时保留原值，返回轮换值时下一次刷新使用新值。
5. 刷新失败向上保留原因，不污染旧凭据，下一次允许重试。
6. 实例、返回快照互相隔离；修改读取到的对象不能改写内部凭据。

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

## 0.2.0 认证请求与任务生命周期组合

TokenSession新增 authorized<T>(id,work:(accessToken:string,signal:AbortSignal)=>Promise<T>):Promise<T>：先登记TaskGroup成员，再通过共享refresh获得token，仅未注销/未取消时启动work。同实例并发请求共享刷新但传输各自独立。logout立即使所有未结算授权请求以SignedOutError拒绝并abort传输signal；迟到刷新成功不能再启动传输。close():Promise<void>先logout，等待所有已启动授权请求的底层work最终结算（包括忽略abort后才完成的清理）；多次close返回同一Promise。

TaskGroup在调用work之前必须登记成员，允许work同步调用cancelAll。cancelAll只取消调用瞬间成员，并等待这些底层work结束，取消回调中新登记的成员不受影响。活动id重复以错误含duplicate的拒绝Promise报告，旧成员结束不得误删已复用id的新成员。刷新端口可同步重入refresh；共享在途请求必须在调用端口前登记；各refresh返回对象不可互相改写。已注销后的迟到刷新错误也转SignedOutError，未注销失败仍保留原因。
