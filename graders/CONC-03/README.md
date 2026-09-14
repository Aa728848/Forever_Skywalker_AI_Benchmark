# CONC-03 受信侧资产与独立验证计划

隐藏检查注入 `__checks__/`，只导入工作区的 `starter/src/locks.ts`；全部用显式 `Release` 驱动，不使用真实计时器。

| 路径 | 用途 |
| --- | --- |
| `checks/locks.hidden.test.ts` | 未公开检查：立即授予、先来先服务、禁止插队、释放幂等、资源独立 |
| `reference.patch` | 参考修复：队列非空即入队 + 释放唤醒队首 |
| `alternative/starter/src/locks.ts` | 替代实现：每个资源一个显式 FIFO 队列 |

验证：`pnpm task:verify CONC-03`。
