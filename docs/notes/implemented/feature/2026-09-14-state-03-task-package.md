# Agent Note: STATE-03 题目包（检查点恢复和不可重复入账）

Status: implemented

## Problem

崩溃恢复路径最容易出的错是**重复入账**：恢复时从头重放整本日志，已经入账的部分被再计一次，
余额随着每次恢复不断膨胀。这类缺陷在正常路径上完全看不出来，只在重启/重放时才暴露。

## Decision

- 冻结 `CheckpointStore`（`apply`/`recover`/`balance`/`checkpoint`）与 `Journal`、`LedgerError`。
- 缺陷族只有一条：**不以检查点为界重放**（每次都从头重放整本日志）。
- 参考实现 `recover()` 只重放 `checkpoint` 之后的条目并推进检查点；
  替代实现缓存已入账金额、按已见条数切片（结构不同）。
- 契约写明：进程重启后新建实例从同一本日志恢复，**每个条目只入账一次**；`recover()` 可重复调用且余额不变。

## Alternatives considered

- 用文件系统做日志：会把测试变成 IO 测试，与考点（重放边界）无关，因此用内存 Journal。
- 让 `apply` 直接返回日志全文：契约要求返回余额，避免调用方依赖内部结构。

## Consequences

- 困难档 9/12；核心题 33/48。
- 与 CACHE-03（失效竞态）、API-03（序列恢复）形成一组：三道题都在考同一件事——
  **跨时间/跨重启的重复投递必须被显式挡住，而不是靠调用方自觉**。

## Verification

- `node scripts/task.ts verify STATE-03`：六阶段通过——起始版本只被 6 个同族检出项判失败，参考实现与替代实现全部通过。
- `pnpm check`：exit 0。
