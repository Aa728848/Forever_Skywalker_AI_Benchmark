# CACHE-01 受信侧资产与独立验证计划

本目录只对受信验证方可见，不进入候选工作区（导出只复制 manifest 的 `workspace.entries`）。

| 路径 | 用途 |
| --- | --- |
| `checks/ttl-cache.hidden.test.ts` | 未公开检查：多键 LRU 顺序、刷新后逐出、过期不计数、逐条目 TTL、has 不刷新、delete/clear |
| `reference.patch` | 参考修复：最近使用顺序 + `now >= expiresAt` + 零值 TTL 语义 |
| `alternative/starter/src/ttl-cache.ts` | 替代实现：显式 touched 序号 + 线性选victim |

隐藏检查在导出之后注入 `__checks__/`，只导入工作区的 `starter/src/ttl-cache.ts`；
时间全部来自注入的时钟，不用 sleep 碰撞过期边界。

## 独立验证计划

1. 导出候选工作区，断言其中没有 `__checks__`、`graders/` 或 `reference.patch`。
2. 未修复的起始版本只应在 `grader.defectDetectors` 声明的检查上失败。
3. 应用参考补丁后，公开与隐藏检查必须全部通过。
4. 覆盖替代实现后，公开与隐藏检查必须全部通过。
5. 任一阶段缺失检查 ID 都视为未取得结论。

运行：`pnpm task:verify CACHE-01`。
