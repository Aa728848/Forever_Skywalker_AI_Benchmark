# GRAPH-03 受信侧资产与独立验证计划

本目录只对受信验证方可见，不进入候选工作区：导出只复制 `tasks/core/GRAPH-03/manifest.json` 里
`workspace.entries` 列出的资产，隐藏资产必须位于题目包之外（`packages/tasks` 会强制校验）。

## 资产

| 路径 | 用途 |
| --- | --- |
| `checks/ast.hidden.test.ts` | 未公开检查：更深与更宽的输入、错误路径精度、空 children 等价性 |
| `reference.patch` | 参考修复：显式栈遍历与带 limit 的深度查询 |
| `alternative/starter/src/ast.ts` | 替代实现：双栈后序 + 队列式前序 + BFS 深度 |

隐藏检查在导出之后由受信侧注入 `__checks__/`，只导入工作区的 `starter/src/ast.ts`，
不导入工作区其它文件；递归差分参考只用于检查内部的小树对照。

## 独立验证计划

1. 导出候选工作区，断言其中没有 `__checks__`、`graders/` 或 `reference.patch`。
2. 未修复的起始版本只应在 `grader.defectDetectors` 声明的检查上失败。
3. 应用 `reference.patch` 后，公开与隐藏检查必须全部通过。
4. 覆盖替代实现后，公开与隐藏检查必须全部通过。
5. 任一阶段缺失检查 ID（崩溃、超时、检查被删）都视为未取得结论。

运行：`pnpm task:verify GRAPH-03`；原始输出写入已忽略的 `data/task-runs/GRAPH-03/<时间戳>/`。
