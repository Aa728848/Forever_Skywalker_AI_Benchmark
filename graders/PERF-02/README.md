# PERF-02 受信侧资产与独立验证计划

隐藏检查注入 `__checks__/`，只导入工作区的 `starter/src/window.ts`；复杂度用 Proxy 统计输入访问次数，不依赖计时。

| 路径 | 用途 |
| --- | --- |
| `checks/window.hidden.test.ts` | 未公开检查：窗口范围、补丁命中、访问次数不随列表增长、非法窗口、越界空窗口 |
| `reference.patch` | 参考修复：只遍历窗口下标 |
| `alternative/starter/src/window.ts` | 替代实现：`Array.from` 按窗口下标构造 |

验证：`pnpm task:verify PERF-02`。
