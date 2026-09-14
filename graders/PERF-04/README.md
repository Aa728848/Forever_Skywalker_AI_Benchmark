# PERF-04 受信侧资产与独立验证计划

本目录只对受信验证方可见，不进入候选工作区（导出只复制 manifest 的 `workspace.entries`）。

| 路径 | 用途 |
| --- | --- |
| `checks/replay.hidden.test.ts` | 未公开检查：4 倍规模访问次数比值、每个事件独立会话、缺省会话、输入不可变、原始耗时样本 |
| `reference.patch` | 参考修复：单次遍历 + Map 累计会话消息数 |
| `alternative/starter/src/replay.ts` | 替代实现：索引循环累加后再一次性排序会话统计 |

复杂度断言使用 **可计数的输入**（Proxy 统计元素访问次数），不使用计时，因此与机器负载无关；
计时只作为原始样本记录，并配一个宽松上限，不用来做通过判定。

## 独立验证计划

1. 导出候选工作区，断言其中没有 `__checks__`、`graders/` 或 `reference.patch`。
2. 未修复的起始版本只应在 `grader.defectDetectors` 声明的检查上失败（两个复杂度检查）。
3. 应用参考补丁后，公开与隐藏检查必须全部通过。
4. 覆盖替代实现后，公开与隐藏检查必须全部通过。
5. 任一阶段缺失检查 ID 都视为未取得结论。

运行：`pnpm task:verify PERF-04`。
