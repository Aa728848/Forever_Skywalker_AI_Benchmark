# API-02 受信侧资产与独立验证计划

隐藏检查注入 `__checks__/`，只导入工作区的 `starter/src/page.ts`。

| 路径 | 用途 |
| --- | --- |
| `checks/page.hidden.test.ts` | 未公开检查：首页、末页边界、非法游标、非规范编码、范围与超界偏移 |
| `reference.patch` | 参考修复：decodeCursor 校验前缀/数字并做往返一致性检查 |
| `alternative/starter/src/page.ts` | 替代实现：按前缀切分后逐字符校验数字 |

验证：`pnpm task:verify API-02`。
