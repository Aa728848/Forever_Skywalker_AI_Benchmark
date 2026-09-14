# ARCH-02 受信侧资产与独立验证计划

隐藏检查注入 `__checks__/`，只导入工作区的 `starter/src/providers.ts`；样本里特意放了“名字像浏览器其实是共享”与“浏览器专属但没前缀”两个反例。

| 路径 | 用途 |
| --- | --- |
| `checks/providers.hidden.test.ts` | 未公开检查：Node 侧拆分、浏览器侧拆分、顺序保持、重复与非法元数据、空目录 |
| `reference.patch` | 参考修复：按 `runtime` 元数据判定 |
| `alternative/starter/src/providers.ts` | 替代实现：先按运行时分区再拼接 |

验证：`pnpm task:verify ARCH-02`。
