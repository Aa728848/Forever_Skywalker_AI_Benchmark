# Agent Note: 题库加难方法论（跨实例不变量）

Status: implemented

## Problem

四份历史真实模型报告（`data/experiments/`，4 个模型各跑满 16 题）显示：16 道保留题里 11 道 4/4 全过、2 道 3/4，只有 CONC-04 与 ARCH-04 有分化且 ARCH-04 是 0/4。区难度区分度不足，根因不是断言太少，而是**现有检查都在单实例正确性层面**：照着契约实现一遍就能全过，不产生分化。

## Decision

加难的方向定为**跨实例一致性不变量**，而不是增加同类边界断言。以 CACHE-04 为样板：

1. 存储层引入版本判定：`readVersioned()` 返回内容派生的 epoch，`writeAtomicIfUnchanged(text, epoch)` 在版本不符时抛 `StaleWriteError` 且不改文件。
2. 缓存层缓存自己**最后确认过的** epoch，写回时带上它；被拒后立即重新装载最新版本，因此紧随其后的重试应当成功。
3. `recover(journal)` 补齐崩溃前已确认但未合并的条目。
4. 未实现 `VersionedStorage` 的存储走原语义，既有契约全部不变。

要点：**epoch 必须由内容或文件状态派生，不能是实例计数器**。第一版实现把 epoch 存在存储实例字段里，两个实例各有自己的计数器，落后写入照样通过了拒绝判定——这个缺陷是靠"用真实文件跑两实例交错"才暴露的，单元级内存存储测不出来。

替代实现按同一契约但结构不同（行数组 + 前缀拼接、mtime+size 派生版本、`#seen` 字段），在实现过程中也踩到同一个坑：每次写前重新读 epoch 等于总用最新版本，永远不过时；必须缓存初始化时读到的版本。

## Alternatives considered

- 只加更多边界断言：不产生分化，模型照样全过。
- 增加样本量或更大数据集：不能补足交互复杂度。
- 把所有题改成多进程：多数题的场景本身不需要，属于为难度而难度。

## Consequences

CACHE-04 由 13 项检查增至 17 项，版本升 0.3.0，新增四项检查全部可被起始缺陷检出。三向验证通过；三个 mutant 精确命中预声明检出项（publish-before-durable-write 额外交叉命中 public/state-write-failure，属有效检出、原样保留）。

方法论可复用：其余 12 道假难题按同样思路各加一层该题域特有的跨实例/跨进程不变量。难度标签仍以实测通过率校准，不因本次加难预先改写。

## Verification

- `node scripts/task.ts verify CACHE-04`：六阶段通过（starter 10 项按预声明失败、reference 与 alternative 全过）。
- `pnpm task:mutants CACHE-04`：3/3 精确检出，报告见 `data/task-mutations/CACHE-04/2026-10-18T15-20-20-034Z`。
- `pnpm check`：414 项测试、严格类型、目录一致性与生产构建通过。
