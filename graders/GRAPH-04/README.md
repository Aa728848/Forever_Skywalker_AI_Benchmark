# GRAPH-04 受信侧资产与独立验证计划

隐藏检查注入 `__checks__/`，只导入工作区的 `starter/src/invalidation.ts`；检查内置朴素全量可达性作为独立对拍基准。

| 路径 | 用途 |
| --- | --- |
| `checks/invalidation.hidden.test.ts` | 未公开检查：直接依赖、传递依赖对拍、环收敛、排序确定性、未知节点 |
| `reference.patch` | 参考修复：广度优先传播 + 已访问集合 |
| `alternative/starter/src/invalidation.ts` | 替代实现：递归深度优先 + 已访问集合 |

验证：`pnpm task:verify GRAPH-04`。
