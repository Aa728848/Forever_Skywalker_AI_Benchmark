# THR-01 受信侧资产与独立验证计划

隐藏检查注入 `__checks__/`，只导入工作区的 `starter/src/pool.ts`；worker 入口 `starter/src/worker.ts` 在工作区里冻结。

| 路径 | 用途 |
| --- | --- |
| `checks/pool.hidden.test.ts` | 未公开检查：真实线程、并发窗口、失败记录、空输入、非法窗口 |
| `reference.patch` | 参考修复：真实 worker 窗口调度 + 失败计入 failures |
| `alternative/starter/src/pool.ts` | 替代实现：递归补位调度 |

验证：`pnpm task:verify THR-01`。
