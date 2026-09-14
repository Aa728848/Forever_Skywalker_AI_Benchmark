# BND-01 受信侧资产与独立验证计划

隐藏检查注入 `__checks__/`，只导入工作区的 `starter/src/cli.ts`。

| 路径 | 用途 |
| --- | --- |
| `checks/cli.hidden.test.ts` | 未公开检查：默认值、两种写法、零值语义、未知选项、取值错误、重复选项、位置参数、布尔开关 |
| `reference.patch` | 参考修复：用 Map 记录显式取值 + 未知选项报错 + 端口严格校验 + 布尔不接受取值 |
| `alternative/starter/src/cli.ts` | 替代实现：布尔分支顺序与判空写法不同 |

验证：`pnpm task:verify BND-01`。
