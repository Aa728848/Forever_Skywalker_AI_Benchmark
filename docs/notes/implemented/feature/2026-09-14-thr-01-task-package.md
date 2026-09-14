# Agent Note: THR-01（真实工作线程的分发与汇总）——简单档收尾

Status: implemented

## Problem

简单档最后一道是“真实线程”题。核心风险有两条：
一是**必须用真线程而不是 Promise 并发冒充**（题面明确要求，检查也必须真的能区分）；
二是这类题目容易把检查写成会挂住的形态（worker 不退出、消息永不回来）。

## Decision

- 冻结 `starter/src/worker.ts` 作为 worker 入口（`workerData` 收 job、回报 `threadId` 与结果），
  候选只允许改 `starter/src/pool.ts`，且必须用 `new URL('./worker.ts', import.meta.url)` 启动。
- `PoolOutcome` 增加 `threadIds`：把“谁处理的”变成可观察证据，检查据此断言**至少两个不同线程 id、且不含主线程 id 0**——
  这是主线程假并发无法伪造的证据（第一版起始版本 threadIds 恒为空）。
- 两个缺陷族：① 主线程 Promise 并发冒充线程池；② 失败 job 被静默丢弃（既不在 results 也不在 failures）。
- 参考实现按 `size` 建立固定窗口、每个任务一个 worker 并在拿到消息后 `terminate()`；替代实现改成“完成一个补位一个”。

## Alternatives considered

- 用 `SharedArrayBuffer`/`Atomics` 证明并发：实现与检查都更复杂，而 `threadId` 已经足够区分真假线程。
- 检查“同时并发的线程数 ≤ size”：**这是错的**，我第一版就这么写，结果参考实现反而失败——
  因为“每任务一个 worker”会先后用到多于 `size` 个不同线程；`size` 约束的是同时并发数，不是累计线程数。
  该断言已删除，题面同步改为明确措辞。

## Consequences

- 简单档 12/12 完成；核心题 18/48。
- 这道题同时给出了“如何把并发结构变成可观察证据”的范式：让被测实现回报它实际用了哪些资源，
  再由检查断言资源身份，而不是靠计时或猜测。

## Verification

- `node scripts/task.ts verify THR-01`：六阶段通过——起始版本只被 3 个声明检出项判失败（真实线程、失败记录、非法窗口），
  参考实现与替代实现全部通过。
- `pnpm check`：exit 0。

