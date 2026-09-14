# PERF-02 受信侧资产与独立验证计划

题目版本 0.2.0。隐藏检查注入 `__checks__/`，只导入工作区的 `starter/src/window.ts`；复杂度用 Proxy 统计输入访问次数，浏览器部分实际启动 Chromium/Edge，不能用伪造 DOM 替代。

| 路径 | 用途 |
| --- | --- |
| `checks/window.hidden.test.ts` | 未公开检查：窗口范围、补丁命中、访问次数不随列表增长、非法窗口、越界空窗口 |
| `checks/dom.hidden.test.ts` | 真实 DOM：窗口重叠节点复用、MutationObserver 无变化检查、纯文本 ID、更新保留和销毁监听 |
| `checks/browser.ts` | 无第三方依赖的受信浏览器启动器；优先 `BENCH_BROWSER_EXECUTABLE` |
| `reference.patch` | 参考修复：只遍历窗口下标，以节点 Map 保留可见 DOM |
| `alternative/starter/src/window.ts` | 替代实现：`Array.from` 按窗口下标构造；每次从当前 DOM 建立键索引 |
| `benchmark.ts` / `benchmark-policy.json` | 真实窗口算法 workload 与未校准的公开计时比值策略 |

验证：`pnpm task:verify PERF-02`。

性能采样命令：`node graders/PERF-02/benchmark.ts <冻结工作区>`。只允许由受信平台选择此固定脚本，在与候选相同的执行边界内运行；每次调用返回 JSON，全部热迭代都核对窗口语义。平台在参考/候选之间交替预热 2 轮、采样 7 对，使用**外部进程计时**并记录原始样本。JSON 内部耗时、吞吐和 RSS 只作诊断，不能采信候选同进程自报指标作为正式证据。策略当前 `calibrated=false`。
