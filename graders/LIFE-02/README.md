# LIFE-02 受信侧资产与独立验证计划

隐藏检查注入 `__checks__/`，只导入工作区的 `starter/src/stream.ts`。

| 路径 | 用途 |
| --- | --- |
| `checks/stream.hidden.test.ts` | 未公开检查：正常结束、结束后忽略、出错后忽略、超时冻结、快照语义 |
| `reference.patch` | 参考修复：引入终态状态机，终态后忽略一切事件 |
| `alternative/starter/src/stream.ts` | 替代实现：frozen 布尔 + switch 分派 |

验证：`pnpm task:verify LIFE-02`。
