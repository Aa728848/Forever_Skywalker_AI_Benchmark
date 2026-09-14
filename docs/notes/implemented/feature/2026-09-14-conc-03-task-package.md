# Agent Note: CONC-03 题目包（锁的公平调度与饥饿控制）

Status: implemented

## Problem

按资源串行化的锁管理器如果调度不公平，就会出现**饥饿**：资源空闲时新请求越过排队者（插队），
释放时又唤醒最后入队者（LIFO），先来的请求可能永远等不到。这类缺陷在单次功能测试里看不出来，
要在“多个等待者 + 一次释放”的组合下才暴露。

## Decision

- 冻结 `LockManager`（`acquire`/`queueLength`/`Release`）。
- 缺陷族只有一条：**调度不公平**（队列非空也能插队 + 释放唤醒最后一个）。
- 参考实现：只要队列非空就入队；释放时 `shift()` 队首并同步补位。
  替代实现结构不同：每个资源一个显式 FIFO 数组，队首在释放时补位。

## Alternatives considered

- 检查里 `await` 排队 promise 的结算：**实测会挂住**——LIFO 缺陷下队首永不结算，阶段直接超时（`exit=null`）。
  改成「谁先拿到资源」的副作用断言 + 三次微任务让位，既不挂住也能区分公平与否。
- 把“多资源全有或全无”也放进本题：会引入第二个缺陷族，留作后续题目。

## Consequences

- 困难档 6/12；核心题 30/48。
- 又积累一条硬口径：**检查绝不能 `await` 一个可能永不结算的 promise**。
  截至目前因这条踩过三次（CONC-01、FE-02、CONC-03），现在它是制作清单里的固定检查项。

## Verification

- `node scripts/task.ts verify CONC-03`：六阶段通过——起始版本只被 4 个同族检出项判失败，
  参考实现与替代实现全部通过。
- `pnpm check`：exit 0。

