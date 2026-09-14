# CACHE-03 受信侧资产与独立验证计划

隐藏检查注入 `__checks__/`，只导入工作区的 `starter/src/cache.ts`；端口用可控假实现，按需结算，不使用真实计时器。

| 路径 | 用途 |
| --- | --- |
| `checks/cache.hidden.test.ts` | 未公开检查：命中复用、失效重载、在途旧结果丢弃、多次失效、跨 key 独立 |
| `reference.patch` | 参考修复：入缓存前校验发起版本，过期结果只返回不落缓存 |
| `alternative/starter/src/cache.ts` | 替代实现：generation 计数 + 显式过期判定 |

验证：`pnpm task:verify CACHE-03`。
