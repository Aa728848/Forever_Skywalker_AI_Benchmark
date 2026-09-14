# PERF-01 受信侧资产与独立验证计划

隐藏检查注入 `__checks__/`，只导入工作区的 `starter/src/summary.ts`；复杂度用 Proxy 统计输入访问次数，不依赖计时。

| 路径 | 用途 |
| --- | --- |
| `checks/summary.hidden.test.ts` | 未公开检查：4 倍规模访问比值、解析与累加、非法行、差分一致、输入不可变 |
| `reference.patch` | 参考修复：单次遍历 + Map 累加 |
| `alternative/starter/src/summary.ts` | 替代实现：普通对象累加 + 结束排序 |

验证：`pnpm task:verify PERF-01`。
