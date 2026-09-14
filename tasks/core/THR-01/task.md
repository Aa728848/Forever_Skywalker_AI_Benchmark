# THR-01 · 真实工作线程的分发与汇总

- 难度：简单；题型：独立核心题；能力域：真实线程与并发。运行时：TypeScript on Node.js 24（类型剥离）。题目版本：0.1.1。

## 背景

`starter/src/pool.ts` 应该把一组 job 分发给真实 worker 线程并汇总结果。当前实现用主线程的 `Promise` 并发冒充线程池，
并且把失败的 job 静默丢弃。请在**不改变公开接口**的前提下修复；`starter/src/worker.ts` 是冻结的 worker 入口，不得修改。

## 公开接口（冻结）

```ts
export interface Job { readonly id: string; readonly payload: number }
export interface PoolOutcome {
  readonly results: Record<string, number>;
  readonly failures: readonly string[];
  readonly threadIds: readonly number[];
}
export interface PoolOptions { readonly size?: number }
export function runPool(jobs: readonly Job[], options?: PoolOptions): Promise<PoolOutcome>;
```

## 必须满足的行为契约

1. 每个 job 必须由 `node:worker_threads` 的**真实 worker 线程**处理（worker 入口为 `new URL('./worker.ts', import.meta.url)`），
   并把处理该 job 的 `threadId` 记入 `threadIds`；**主线程 id `0` 不得出现**。
2. 多 job 且 `size ≥ 2` 时至少要出现两个不同的线程 id；并发窗口由 `size` 限制（缺省 4），
   整个调用实际创建的线程总数不得超过 `size`，也不得超过 job 数量；返回前所有 worker 已退出。固定 workerData 接受单个 Job 或 Job 数组，可按批次分发。
3. `results` 按 job `id` 汇总（顺序无关）；worker 判定失败的 job（`payload < 0`）进入 `failures`，
   既不出现在 `results` 里，也不得影响其它 job。
4. 空输入立即返回 `{ results: {}, failures: [], threadIds: [] }`，不创建任何线程。
5. `size` 必须是 ≥1 的整数，否则抛 `RangeError`。
6. 不修改传入的 `jobs` 数组。

## 限制

- 只改 `starter/src/pool.ts`；不得修改 `starter/src/worker.ts`；不得引入第三方依赖；
  不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

## 判定

- 参考实现通过全部公开与未公开检查；缺陷起始版本只被声明的检出项判失败；替代实现同样通过。
- 本阶段产出检查结论与可用验证分；代码质量评审接入前总分保持待定。
