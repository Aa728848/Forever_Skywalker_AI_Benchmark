# CONC-04 受信侧资产与独立验证计划

本目录只对受信验证方可见，不进入候选工作区（导出只复制 manifest 的 `workspace.entries`）。

| 路径 | 用途 |
| --- | --- |
| `checks/job-runner.hidden.test.ts` | 未公开检查：副作用后崩溃、检查点后崩溃、账本权威性、乱序重复混合、构造不读账本 |
| `reference.patch` | 参考修复：先落检查点再执行副作用，恢复时补齐未确认副作用 |
| `alternative/starter/src/job-runner.ts` | 替代实现：单字段 `unsettled` 记录未结算副作用 |

检查用假存储与假账本注入崩溃：**副作用之后的下一次写入**抛错，模拟「副作用已执行但尚未确认」；
恢复阶段使用新的 `JobRunner` 实例，确保状态只能来自存储。

## 独立验证计划

1. 导出候选工作区，断言其中没有 `__checks__`、`graders/` 或 `reference.patch`。
2. 未修复的起始版本只应在 `grader.defectDetectors` 声明的检查上失败。
3. 应用参考补丁后，公开与隐藏检查必须全部通过。
4. 覆盖替代实现后，公开与隐藏检查必须全部通过。
5. 任一阶段缺失检查 ID 都视为未取得结论。

运行：`pnpm task:verify CONC-04`。
