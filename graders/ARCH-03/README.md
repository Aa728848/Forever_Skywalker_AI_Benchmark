# ARCH-03 受信侧资产与独立验证计划

隐藏检查注入 `__checks__/`，只导入工作区的 `starter/src/repository.ts`；两个适配器都用假实现，同步与异步两条路径都覆盖。

| 路径 | 用途 |
| --- | --- |
| `checks/repository.hidden.test.ts` | 未公开检查：旧适配器契约、v2 状态映射、秒转毫秒、错误统一包装、不修改适配器 |
| `reference.patch` | 参考修复：v2 路径做契约映射并统一包装错误 |
| `alternative/starter/src/repository.ts` | 替代实现：先归一成公共结果再包错误 |

验证：`pnpm task:verify ARCH-03`。
