# GRAPH-01 受信侧资产与独立验证计划

隐藏检查注入 `__checks__/`，只导入工作区的 `starter/src/tree.ts`。

| 路径 | 用途 |
| --- | --- |
| `checks/tree.hidden.test.ts` | 未公开检查：前序与叶子、节点上限、非法结构、循环拒绝、共享节点按次访问 |
| `reference.patch` | 参考修复：路径祖先检测 + 上限检查 + 缺省 children 也算叶子 |
| `alternative/starter/src/tree.ts` | 替代实现：显式栈迭代 + 祖先数组 |

验证：`pnpm task:verify GRAPH-01`。
