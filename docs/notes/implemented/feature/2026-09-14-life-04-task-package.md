# Agent Note: LIFE-04 题目包（子进程故障、回收与验收重入隔离）

Status: implemented

## Problem

验收型任务用子进程执行。若宿主**不隔离重入**，已有验收在途时再次调用就会启动第二个子进程：
两个验收争抢资源、结果串台、回收记录混乱。

## Decision

- 冻结 `AcceptanceRunner`（`accept`/`busy`/`reaped`）与 `ChildPort`、`ChildHandle`、`classify`、`BusyError`。
- 缺陷族只有一条：**不隔离重入**（在途时直接再启动一个子进程）。
  故障分类与回收在起始版本里就是对的，因此每阶段只失败重入这一项。
- 参考实现用 `busy` 布尔判定，在途时以 `BusyError` 拒绝；替代实现用当前句柄表示占用（结构不同）。
- 全部通过注入的 `ChildPort` 驱动，不启动真实子进程，检查自行触发退出事件，因此完全确定性。

## Alternatives considered

- 让重入排队而不是拒绝：需要调度与取消语义，超出本题范围；契约选择显式拒绝，调用方自行决定重试。
- 用真实子进程：会把题目变成平台相关测试，且难以稳定复现信号终止。

## Consequences

- 极度困难档 5/12；核心题 36/48。
- 又一次踩到同一条口径：检查里**不能 `await` 一个可能永不结算的 promise**。
  这次是 `assert.rejects` 等一个“其实会解决”的 promise；改成“第二次调用不 await、用副作用断言”后立刻稳定。

## Verification

- `node scripts/task.ts verify LIFE-04`：六阶段通过——起始版本只被 2 个同族检出项判失败，参考实现与替代实现全部通过。
- `pnpm check`：exit 0。
