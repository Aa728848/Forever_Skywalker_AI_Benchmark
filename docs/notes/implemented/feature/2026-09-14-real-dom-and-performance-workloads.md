# Agent Note: 补齐 PERF-02 真实 DOM 契约与两道性能题的原始测量

Status: implemented

## Problem

PERF-02 的目录要求长列表局部渲染，但原题只有纯函数数组窗口检查，未验证浏览器节点身份、焦点或交互。PERF-04 的名称包含延迟、吞吐与内存，原实现只记录三次耗时的中位数，没有完整有序原始样本，也没有可供参考/候选成对运行的固定性能工作负载。

## Decision

- 两题版本提升为 0.2.0，原有 `updateRows` / `replaySession` 的签名和结果语义保留。
- PERF-02 新增 `mountList`：真实浏览器只挂载可见行、点击加一、局部更新保留 DOM 和焦点、窗口移动重用重叠行、更新持久保留、非法窗口原子拒绝、销毁清理事件监听。
- 公开和隐藏检查使用从 `graders/shared/browser.ts` 复制的无第三方依赖 Chromium/Edge 启动器；TypeScript 由 Node 原生类型剥离后作为浏览器 ES module 运行。隐藏检查用 MutationObserver、DOM 节点引用和原生按钮点击取得事实，没有伪造 DOM。
- 缺陷 starter 同时保留全列表遍历与全窗口 DOM 重建两个真实问题；参考解使用节点 Map，替代解每次从当前 DOM 建立索引，均满足同一契约。
- PERF-04 的基本资源检查保留 2 次预热、7 次有序耗时/RSS/堆原始样本，仅用宽松终止上限判断最低可用资源。
- 两题各新增受信 `benchmark.ts` 与公开、未校准的 `benchmark-policy.json`。固定输入分别为 80,000 行/20 行窗口/4,000 次更新，以及 32,000 事件/2,000 会话/12 次完整重放。每次热执行同时核对完整语义。
- 工作负载 JSON 内部的时间/RSS只能诊断；平台必须从进程外计时和采样，并按固定环境预热 2 轮、参考/候选交替采集 7 对。报告完整保留样本与环境哈希；阈值未校准不能发布正式成绩。

## Alternatives considered

未继续用数组返回值冒充渲染，也未引入 jsdom 等模拟 DOM。复用已有 Chromium/Edge 二进制与共享受信启动器，保证独立题目导出不需要 npm 包。未删除复杂度计数检查：它证明最低算法资源约束，独立计时测量另行保留，不能对同一阈值重复扣分。

## Consequences

PERF-02 开发机需要 Chromium、Chrome 或 Edge，自动探测标准安装路径，也支持 `BENCH_BROWSER_EXECUTABLE`。容器镜像必须预装 Chromium；内存预算调整为 1024 MB。题库版本由题目清单代理同步为 0.2.0。工作负载只允许由平台选择受信脚本，不接受候选提交的测量命令。

## Verification

- `node scripts/task.ts verify PERF-02`：六阶段通过；starter 恰好失败于声明的五项检测（两项数组复杂度、三项 DOM 复用/mutation）；参考与替代实现的真实 Edge 公开/隐藏检查全通过。原始证据：`data/task-runs/PERF-02/2026-09-14T09-53-30-814Z/`。
- `node scripts/task.ts verify PERF-04`：六阶段通过；starter 的两个预先声明缺陷准确检出，参考与替代全通过。原始证据：`data/task-runs/PERF-04/2026-09-14T09-53-43-035Z/`。
- 两道工作负载分别对参考与替代实现执行实际 2 轮预热 + 7 对交替测量，完整语义校验通过；外部耗时比值中位数分别约 1.052、1.043。报告：`data/benchmarks/perf-workloads-2026-09-14T09-54-40-430Z/PERF-02.json` 与同目录 `PERF-04.json`，含每次进程外时间和内部诊断指标。
- 以上测量来自 Windows 宿主，运行时及系统负载条件已记录；没有宣称容器隔离、正式性能校准或模型评审通过。
- 并行类型检查曾遇到另一个变更的 `tests/e2e/workbench.spec.ts` 导入路径问题，交给负责人修复后，最终 `node node_modules/typescript/bin/tsc --noEmit` 通过。
