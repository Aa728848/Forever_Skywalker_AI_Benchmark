# CONC-01 受信侧资产与独立验证计划

隐藏检查注入 `__checks__/`，只导入工作区的 `starter/src/cancelable.ts`；用假调度器触发超时，不依赖真实计时。

| 路径 | 用途 |
| --- | --- |
| `checks/cancelable.hidden.test.ts` | 未公开检查：成功路径、取消语义、超时语义、定时器释放、同步抛出与结算后取消 |
| `reference.patch` | 参考修复：统一 finish 路径 + cancel/超时都 abort signal + 结算时取消定时器 |
| `alternative/starter/src/cancelable.ts` | 替代实现：显式 pending/done 状态机 |

验证：`pnpm task:verify CONC-01`。
