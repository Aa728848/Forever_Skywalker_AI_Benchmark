# STATE-03 受信侧资产与独立验证计划

隐藏检查注入 `__checks__/`，只导入工作区的 `starter/src/ledger.ts`；日志用内存实现，不需要文件系统。

| 路径 | 用途 |
| --- | --- |
| `checks/ledger.hidden.test.ts` | 未公开检查：入账与检查点、重复恢复不重复入账、重启恢复、外部追加条目、非法条目 |
| `reference.patch` | 参考修复：recover 只重放检查点之后的条目 |
| `alternative/starter/src/ledger.ts` | 替代实现：缓存已入账数组并按已见条数切片 |

验证：`pnpm task:verify STATE-03`。
