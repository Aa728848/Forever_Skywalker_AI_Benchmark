# CONC-03 · 多资源锁顺序和饥饿控制

- 难度：困难；题型：独立核心题；能力域：异步并发。运行时：TypeScript on Node.js 24。题目版本：0.2.0。

## 背景

`starter/src/locks.ts` 是一个按资源名串行化的锁管理器。当前实现的调度**不公平**：
资源空闲时新请求可以直接越过排队者（插队），释放时又唤醒**最后**入队者（LIFO），
先来的请求可能被无限推迟——典型的饥饿。请在**不改变公开接口**的前提下修复。

## 公开接口（冻结）

```ts
export type Release = () => void;
export class LockManager {
  get queueLength(): number;
  acquire(resource: string): Promise<Release>;
}
```

## 必须满足的行为契约

1. 资源空闲**且没有人在排队**时立即授予，返回的 `Release` 用于释放。
2. 资源被占用，或虽空闲但已有等待者时，新请求必须**入队**（先来先服务），不得插队。
3. 释放时把资源交给**队首**等待者；队列清空后才算真正空闲。
4. `Release` 幂等：重复调用不得释放别人的锁、不得重复唤醒。
5. `queueLength` 反映当前等待者总数；不同资源之间互不影响。

## 限制

- 只改 `starter/`；不得引入第三方依赖；不得使用真实计时器；不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

## 判定

- 参考实现通过全部公开与未公开检查；缺陷起始版本只被声明的检出项判失败；替代实现同样通过。
- 本阶段产出检查结论与可用验证分；代码质量评审接入前总分保持待定。

## 0.2.0 多资源事务申请

新增 acquireMany(resources: readonly string[], signal?: AbortSignal): Promise<Release>；原 acquire(resource) 与单资源契约保留。一次请求中的资源去重且输入不变，空集合可立即取得幂等释放函数。整组必须同时授予，等待期间不得持有子集。queueLength 统计等待请求数，不按资源数累加。

按请求到达顺序处理：请求与任何更早尚未授予的请求共享资源时不得越过；无冲突请求可前进，不能全局串行堵塞。取消等待中的整组请求以 signal.reason 拒绝，移除监听器与排队约束并立即推进其它可授予者；预取消信号不得排队。已授予请求不受后续 abort 影响，仍由持有者显式整体释放。释放幂等，任何旧释放函数不得释放下一位的所有权。不依赖真实时间，测试用实际 Promise 交错观察所有权。
