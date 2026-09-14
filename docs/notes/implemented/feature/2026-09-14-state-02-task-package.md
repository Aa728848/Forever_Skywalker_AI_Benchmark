# Agent Note: STATE-02 题目包（状态迁移与旧版本契约）

Status: implemented

## Problem

持久化格式演进最容易埋的坑是“旧数据静默被当成新格式”：v1 用 `status`、状态名也不同，
v2 用 `state`。若不看版本就直接读 `state`，v1 数据要么报结构错误、要么被当成未知版本放行，
线上表现是**老用户的订单消失或状态错乱**。

## Decision

- 冻结 `migrate(raw): Snapshot` 与三种错误（`InvalidSnapshotError`/`UnsupportedVersionError`/`UnknownStateError`），
  以及 `orderStates` 常量。
- 缺陷族只有一条：**不看版本、不认 v1**（直接把 `state` 当 v2 读）。
- 参考实现按版本分派：v2 校验状态名后原样返回；v1 用冻结映射 `new→draft`、`active→placed`、`done→shipped`；
  其它（含缺 `version`）抛 `UnsupportedVersionError(String(version))`。
- 替代实现结构不同：`switch` 分派到独立函数，映射表用 `Map`。

## Alternatives considered

- 宽松迁移（猜字段、猜状态名）：会把数据结构错误掩盖成“看起来还行”的状态，正是本题要防的。
- 把 `rejects-invalid-snapshots` 拆成独立缺陷：会让缺陷族扩散，违反“一题一缺陷族”。

## Consequences

- 中等档 8/12；核心题 23/48。
- 本题把“错误类型也是契约”写进了题面：三种失败对应三个错误类，检查按错误类型断言，
  这样候选不能靠“统一抛一个 Error”蒙过去。

## Verification

- `node scripts/task.ts verify STATE-02`：六阶段通过——起始版本只被同一缺陷族的 8 个检出项判失败，
  参考实现与替代实现全部通过。
- `pnpm check`：exit 0。

