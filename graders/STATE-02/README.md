# STATE-02 受信侧资产与独立验证计划

隐藏检查注入 `__checks__/`，只导入工作区的 `starter/src/snapshot.ts`。

| 路径 | 用途 |
| --- | --- |
| `checks/snapshot.hidden.test.ts` | 未公开检查：v2 直通、v1 映射、未知版本、非法结构、幂等 |
| `reference.patch` | 参考修复：按版本分派 + v1 冻结映射 + 未支持版本报错 |
| `alternative/starter/src/snapshot.ts` | 替代实现：switch 分派 + Map 映射表 |

验证：`pnpm task:verify STATE-02`。
