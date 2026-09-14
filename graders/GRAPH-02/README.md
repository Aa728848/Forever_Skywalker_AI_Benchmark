# GRAPH-02 受信侧资产与独立验证计划

隐藏检查注入 `__checks__/`，只导入工作区的 `starter/src/graph.ts`。

| 路径 | 用途 |
| --- | --- |
| `checks/graph.hidden.test.ts` | 未公开检查：简单 DAG、字典序确定性、重复边去重、环与未知节点、空图 |
| `reference.patch` | 参考修复：边去重 + 后继与起始层排序 + 有序插入 |
| `alternative/starter/src/graph.ts` | 替代实现：每轮从剩余节点里线性挑最小的零入度节点 |

验证：`pnpm task:verify GRAPH-02`。
