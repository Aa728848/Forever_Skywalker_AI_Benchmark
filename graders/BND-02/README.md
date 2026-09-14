# BND-02 受信侧资产与独立验证计划

本目录只对受信验证方可见，不进入候选工作区（导出只复制 manifest 的 `workspace.entries`）。

| 路径 | 用途 |
| --- | --- |
| `checks/verdict.hidden.test.ts` | 未公开检查：未闭合围栏、其它 info 围栏、嵌套转义参数、结构错误码、分数边界、输入不可变 |
| `reference.patch` | 参考修复：按围栏边界解析 + 参数字符串再解析 |
| `alternative/starter/src/verdict.ts` | 替代实现：非贪婪正则收集围栏块 + 另一种校验循环 |

隐藏检查在导出之后注入 `__checks__/`，只导入工作区的 `starter/src/verdict.ts`。

## 独立验证计划

1. 导出候选工作区，断言其中没有 `__checks__`、`graders/` 或 `reference.patch`。
2. 未修复的起始版本只应在 `grader.defectDetectors` 声明的检查上失败。
3. 应用参考补丁后，公开与隐藏检查必须全部通过。
4. 覆盖替代实现后，公开与隐藏检查必须全部通过。
5. 任一阶段缺失检查 ID 都视为未取得结论。

运行：`pnpm task:verify BND-02`。
