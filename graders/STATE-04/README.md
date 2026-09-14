# STATE-04 受信侧资产与独立验证计划

隐藏检查注入 `__checks__/`，只导入工作区的 `starter/src/consistency.ts`；三层用可观察内存实现（记录 apply/revert 事件序列）。

| 路径 | 用途 |
| --- | --- |
| `checks/consistency.hidden.test.ts` | 未公开检查：顺序、完整回滚、失败后一致、错误层名、幂等 |
| `reference.patch` | 参考修复：记录已应用层并在失败时反向回滚 |
| `alternative/starter/src/consistency.ts` | 替代实现：先收集撤销闭包再统一执行 |

验证：`pnpm task:verify STATE-04`。

0.1.1 增加 starter/src/durable-coordinator.ts 的真实文件、进程提交后退出、重启投影重建与旧通知隔离；参考原子 JSON 与替代 JSONL 均通过。
