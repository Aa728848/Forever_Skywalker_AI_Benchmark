# FE-01 受信侧资产与独立验证计划

本目录只对受信验证方可见，不进入候选工作区（导出只复制 manifest 的 `workspace.entries`）。

| 路径 | 用途 |
| --- | --- |
| `checks/feed.hidden.test.ts` | 未公开检查：重试与重叠交错、视图回调序列、错误清空、空页游标、实例隔离、大页去重 |
| `reference.patch` | 参考修复：按 id 去重追加 + 失败路径恢复 busy 并记住待重试分页 |
| `alternative/starter/src/feed.ts` | 替代实现：状态集中在字段对象里，统一 commit 路径 |

隐藏检查在导出之后注入 `__checks__/`，只导入工作区的 `starter/src/feed.ts`；
检查用受控 deferred 驱动异步结算，不依赖 sleep。

## 独立验证计划

1. 导出候选工作区，断言其中没有 `__checks__`、`graders/` 或 `reference.patch`。
2. 未修复的起始版本只应在 `grader.defectDetectors` 声明的检查上失败。
3. 应用参考补丁后，公开与隐藏检查必须全部通过。
4. 覆盖替代实现后，公开与隐藏检查必须全部通过。
5. 任一阶段缺失检查 ID 都视为未取得结论。

浏览器级（Playwright）确认不在本阶段范围，留待 Windows/浏览器专项。

运行：`pnpm task:verify FE-01`。
