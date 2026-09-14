# API-01 受信侧资产与独立验证计划

隐藏检查（`checks/request.hidden.test.ts`）在导出之后注入 `__checks__/`，只导入工作区的 `starter/src/request.ts`。

| 路径 | 用途 |
| --- | --- |
| `checks/request.hidden.test.ts` | 未公开检查：隐藏样本下的合法/缺失/类型/边界/未知字段/多问题/非对象/副本语义 |
| `reference.patch` | 参考修复：收集全部问题 + 拒绝未知字段 + 拒绝数字字符串 + 边界 1..1000 + note 校验 + 冻结副本 |
| `alternative/starter/src/request.ts` | 替代实现：用 `Object.prototype.toString` 判对象、先收集未知字段再逐项校验 |

验证：`pnpm task:verify API-01`（六阶段）。
