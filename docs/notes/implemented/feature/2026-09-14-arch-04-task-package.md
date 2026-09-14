# Agent Note: ARCH-04 题目包（插件热切换、失败回滚与资源归属）

Status: implemented

## Problem

热切换最常见的实现错误是**先拆旧的再装新的**：一旦新插件启动失败，旧插件已经没了，
系统进入无插件状态，而新插件启动时占用的资源也没人释放——既不可用又泄漏。
正确做法是把切换做成可回滚的事务。

## Decision

- 冻结 `PluginHost`（`switchTo`/`active`/`released`）与 `Plugin`、`SwitchError`。
- 缺陷族只有一条：**先释放旧插件再启动新插件**（失败无回滚、新插件资源不释放）。
- 参考实现：先 `setup` 新插件；失败则 `teardown` 新插件并保留旧插件（以 `SwitchError` 带 from/to 拒绝）；
  成功才切换 `active` 并 `teardown` 旧插件。替代实现改成显式的 prepare/commit/rollback 阶段机（结构不同）。
- `released` 作为**资源归属证据**暴露给检查：谁被释放、释放了几次都可以断言，不需要窥探内部状态。

## Alternatives considered

- 让插件自己保证幂等 teardown：把契约推给实现方，无法验证宿主是否真的回滚；
  本题把“每个插件最多 teardown 一次”写进契约并由 `released` 断言。
- 用真实文件/端口做资源：会把题目变成 IO 题；用可观察假实现即可覆盖考点。

## Consequences

- 极度困难档 4/12；核心题 35/48。
- 与 ARCH-02（元数据归属）、ARCH-03（契约边界）形成架构簇：三题都要求把隐式约定写成显式、可断言的行为。

## Verification

- `node scripts/task.ts verify ARCH-04`：六阶段通过——起始版本只被 4 个同族检出项判失败，参考实现与替代实现全部通过。
- `pnpm check`：exit 0。
