# LIFE-03 受信侧资产与独立验证计划

隐藏检查注入 `__checks__/`，只导入工作区的 `starter/src/supervisor.ts`；runner 用可控实现，收到 abort 时结算，检查不会挂住。

| 路径 | 用途 |
| --- | --- |
| `checks/supervisor.hidden.test.ts` | 未公开检查：启停、重复启动幂等、停止期间重启、重复停止、停止后重启 |
| `reference.patch` | 参考修复：start 前等待停止完成 + 每次启动新建 controller |
| `alternative/starter/src/supervisor.ts` | 替代实现：串行队列调度所有操作 |

验证：`pnpm task:verify LIFE-03`。
