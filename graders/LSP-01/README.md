# LSP-01 受信侧资产与独立验证计划

本目录只对受信验证方可见，不进入候选工作区（导出只复制 manifest 的 `workspace.entries`）。

| 路径 | 用途 |
| --- | --- |
| `checks/checks.fsx` | 未公开检查：逐字节拼接、emoji 正文、缺字段报错、空正文、完整前缀保留 |
| `reference.patch` | 参考修复：按字节扫描头部与正文，保留未消费尾部 |
| `alternative/starter/src/FrameParser.fsx` | 替代实现：按行扫描 + 显式 consumed 游标 |

隐藏检查在导出之后注入 `__checks__/`，只通过 `#load "../starter/src/FrameParser.fsx"` 引入被测模块；
检查脚本自己打印 TAP 行（`ok N - <检查 ID>`），每个检查都用 `try ... with` 包住，失败不会中断其余检查。

## 独立验证计划

1. 导出候选工作区，断言其中没有 `__checks__`、`graders/` 或 `reference.patch`。
2. 未修复的起始版本只应在 `grader.defectDetectors` 声明的检查上失败。
3. 应用参考补丁后，公开与隐藏检查必须全部通过（`dotnet fsi` 退出码 0）。
4. 覆盖替代实现后，公开与隐藏检查必须全部通过。
5. 任一阶段缺失检查 ID 都视为未取得结论。

运行：`pnpm task:verify LSP-01`。
