# LIFE-01 受信侧资产与独立验证计划

隐藏检查注入 `__checks__/`，只导入工作区的 `starter/src/poller.ts`；用假调度器构造触发，不依赖真实计时。

| 路径 | 用途 |
| --- | --- |
| `checks/poller.hidden.test.ts` | 未公开检查：单一定时器、stop 取消、重复 start、重启、空操作、缺省间隔 |
| `reference.patch` | 参考修复：start 幂等 + stop 取消并清空 |
| `alternative/starter/src/poller.ts` | 替代实现：先置 running 再判定时器是否存在 |

验证：`pnpm task:verify LIFE-01`。
