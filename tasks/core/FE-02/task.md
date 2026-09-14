# FE-02 · 异步请求乱序与取消

- 难度：中等；题型：独立核心题；能力域：前端与异步状态。运行时：TypeScript on Node.js 24。题目版本：0.1.0。

## 背景

`starter/src/coordinator.ts` 负责把界面发起的请求交给端口执行。当前实现有三个缺陷：
同 key 的新请求**不取代**旧请求（旧请求照常结算，界面可能被过期结果覆盖）、
`pending` 计数只增不减、`cancelAll()` 既不 abort 也不拒绝挂起的请求。请在**不改变公开接口**的前提下修复。

## 公开接口（冻结）

```ts
export class SupersededError extends Error { readonly key: string }
export interface RequestPort { send(key: string, payload: string, signal: AbortSignal): Promise<string> }
export class RequestCoordinator {
  constructor(port: RequestPort);
  get pending(): number;
  request(key: string, payload: string): Promise<string>;
  cancelAll(): void;
}
```

## 必须满足的行为契约

1. 同一个 key 再次 `request` 时，**旧请求必须先被取代**：旧 signal 被 `abort()`，旧 promise 以 `SupersededError` 拒绝；
   无论端口让哪个先返回，都不允许过期结果兑现到旧 promise 上。
2. 不同 key 互不影响，可同时挂起；最新一次请求的结果必须原样兑现。
3. `pending` 等于当前未结算的请求数：请求发起后 +1，无论成功、失败、被取代还是被取消都必须回到 0。
4. 端口抛错时该 promise 以该错误拒绝，且该 key 之后的新请求不受影响。
5. `cancelAll()` 中止并拒绝所有挂起请求（同样用 `SupersededError`），`pending` 归零；
   之后端口的迟到结算不得改变已结算的 promise。

## 限制

- 只改 `starter/`；不得引入第三方依赖；不得使用真实计时器；不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

## 判定

- 参考实现通过全部公开与未公开检查；缺陷起始版本只被声明的检出项判失败；替代实现同样通过。
- 本阶段产出检查结论与可用验证分；代码质量评审接入前总分保持待定。
