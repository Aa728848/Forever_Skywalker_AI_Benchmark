# CONC-02 受信侧资产与独立验证计划

隐藏检查注入 `__checks__/`，只导入工作区的 `starter/src/group.ts`；成员用可控实现，收到 abort 时结算，检查不会挂住。

| 路径 | 用途 |
| --- | --- |
| `checks/group.hidden.test.ts` | 未公开检查：成员结算、取消传播、等待结算、空取消、失败隔离 |
| `reference.patch` | 参考修复：cancelAll 先 abort、再拒绝、清空并等待全部结算 |
| `alternative/starter/src/group.ts` | 替代实现：成员放数组 + allSettled 等待 |

验证：`pnpm task:verify CONC-02`。
