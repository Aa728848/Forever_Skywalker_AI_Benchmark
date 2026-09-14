# ARCH-01 受信侧资产与独立验证计划

隐藏检查注入 `__checks__/`，只导入工作区的 `starter/src/settings.ts`；用可控端口与环境变量构造对照，确定性断言依赖边界。

| 路径 | 用途 |
| --- | --- |
| `checks/settings.hidden.test.ts` | 未公开检查：端口优先于环境变量、无模块级缓存、缺省与校验、冻结、端口只读 |
| `reference.patch` | 参考修复：全部经端口读取、去掉模块级缓存 |
| `alternative/starter/src/settings.ts` | 替代实现：先把端口值收进局部表再校验 |

验证：`pnpm task:verify ARCH-01`。
