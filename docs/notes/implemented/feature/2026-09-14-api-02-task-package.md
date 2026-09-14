# Agent Note: API-02 题目包（分页游标与边界）

Status: implemented

## Problem

分页游标是最容易被“能跑就行”糊过去的地方：非法游标解出 `NaN`、非规范编码被当成合法偏移，
接口表面成功、实际把请求带到了错误的位置。这道题要求把游标校验做成硬契约。

## Decision

- 冻结 `encodeCursor/decodeCursor/paginate` 与 `PageError`（带 `field`）。
- 缺陷只保留**一个族**：`decodeCursor` 完全不校验（前缀、数字、规范写法都不查）。
  其余行为（`limit` 范围、末页 `nextCursor` 为 `null`、超界偏移返回空页）在起始版本里就是对的，
  因此起始版本每阶段只失败与游标校验相关的检查。
- 参考实现：正则校验 `offset:<非负整数>`，并要求**往返一致**（`encodeCursor(offset) === cursor`），
  因此 `offset:007` 这类非规范编码被拒。
- 替代实现结构不同：先切前缀，再逐字符判断数字，最后比较规范化后的字符串。

## Alternatives considered

- 用不透明签名游标（HMAC）：更贴近生产，但会把密钥管理塞进题目；本题只考“校验与规范”。
- 把缺陷扩到 `limit` 校验：会同时打掉无关检查，违反“一题一缺陷族”。

## Consequences

- 中等档 6/12；核心题 21/48。
- “往返一致”这条规则同时把非规范编码挡在门外，说明**规范性与可解码性可以一次校验完成**，
  不必为每种畸形输入各写一条分支。

## Verification

- `node scripts/task.ts verify API-02`：六阶段通过——起始版本只被 4 个声明检出项（公开 2 + 隐藏 2）判失败，
  参考实现与替代实现全部通过。
- `pnpm check`：exit 0。

