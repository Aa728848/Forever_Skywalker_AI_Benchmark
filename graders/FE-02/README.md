# FE-02 受信侧资产与独立验证计划

隐藏检查注入 `__checks__/`，只导入工作区的 `starter/src/coordinator.ts`；端口用可控假实现，按需结算，不依赖真实计时。

| 路径 | 用途 |
| --- | --- |
| `checks/coordinator.hidden.test.ts` | 未公开检查：取代旧请求、乱序结算、多 key 独立、失败结算 pending、取消全部 |
| `reference.patch` | 参考修复：取代 + abort + 结算清理 pending + cancelAll 中止并拒绝 |
| `alternative/starter/src/coordinator.ts` | 替代实现：generation 世代号判定最新请求 |

验证：`pnpm task:verify FE-02`。
