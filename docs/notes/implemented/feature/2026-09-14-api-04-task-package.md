# Agent Note: API-04 题目包（重启后任务提交与事务一致性）

Status: implemented

## Problem

提交接口最容易缺的是**幂等键**。没有它，同一个提交键重复提交会生成新的 taskId 并覆盖写，
重启后重试更会直接产生第二条任务——用户点两下按钮、网络重试一次，账上就多一条。

## Decision

- 冻结 `TaskSubmitter`（`submit`/`committed`）与 `TaskStore`、`SubmitError`。
- 缺陷族只有一条：**不使用幂等键**（每次新建并覆盖写）。
- 参考实现：先读幂等记录，命中则直接返回原 taskId；未命中才分配新 id，
  且**写失败不推进 `committed`**，调用方重试可成功。替代实现用 `ensure` 私有方法 + 失败后序号回滚（结构不同）。
- 检查里的存储可注入写失败，因此事务性是可断言的（存储条目数 + committed 双向验证）。

## Alternatives considered

- 只做进程内去重（缓存已见键）：重启后失效，正是本题要防的场景，因此必须落到存储。
- 用随机 id + 时间戳：无法在重启后复用，故用「读存储拿原 id」的确定性方案。

## Consequences

- 极度困难档 7/12；核心题 38/48。
- 与 STATE-03（检查点重放）、CACHE-03（失效竞态）、API-03（序列恢复）同属跨重启一致性主题簇。

## Verification

- `node scripts/task.ts verify API-04`：六阶段通过——起始版本只被 6 个同族检出项判失败，参考实现与替代实现全部通过。
- `pnpm check`：exit 0。
