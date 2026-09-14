# Agent Note: M1-05 其余 7 道试点题目包与 M1-06 试跑

Status: implemented

## Problem

M1-01 只完成了 CACHE-02。M1-05 要求其余 7 道试点（FE-01、LSP-01、BND-02、THR-03、GRAPH-03、CONC-04、PERF-04）
同样具备独立起始仓库、公开题目、缺陷复现、参考补丁、公开/保留用例与真实检查；
M1-06 要求在 8 题上试跑并给出可执行状态、难度与成本的初步校准。

## Decision

- 7 道题全部按 CACHE-02 的同一结构落地：`tasks/core/<ID>/`（task.md、manifest.json、starter、public-tests）
  与 `graders/<ID>/`（checks、reference.patch、alternative、README.md）；每道题都通过
  `node scripts/task.ts verify <ID>` 的六阶段验证后才算完成。
- 运行时按题面需要分两类：TypeScript 题用 `node --test --test-isolation=none`；
  LSP-01 与 THR-03 用 F# / .NET 10，检查脚本由 `dotnet fsi` 直接运行并自行打印 TAP，
  平台不需要为 .NET 引入测试框架或 NuGet 依赖。
- 每题都是“一个缺陷族 + 明确检出项”：缺陷只应在 `grader.defectDetectors` 声明的检查上失败，其余检查必须仍然通过。
- 可验证性上的关键取舍：
  - THR-03 用真实 .NET 线程与带超时的 `Barrier`，并把**所有可能被阻塞的调用放在后台线程上带超时执行**，
    因此“回调抛异常不释放锁”表现为检查失败而不是挂住整批检查。
  - CONC-04 用假存储注入崩溃（副作用之后的下一次写入抛错），用账本计数断言副作用恰好一次。
  - PERF-04 用 Proxy 统计输入访问次数来断言复杂度，**不使用计时**；计时只作为原始样本记录并配宽松上限。
  - GRAPH-03 用 20 万节点深链对照浅层递归参考的差分结果，错误语义用 `DepthExceededError` 固定。
  - BND-02 按围栏边界解析而不是贪婪正则，覆盖围栏外花括号、未闭合围栏与再编码一层的工具参数。
- `packages/contracts` 为支持多运行时做了两处调整：题目版本从字面量放开为语义化版本串；
  `nodeRange` 改名为 `runtimeRange`，执行结果的 `nodeVersion` 拆成 `platformVersion` + `candidateRuntimes`。
  FE-01 升到 0.2.0（浏览器级确认延后到 Windows/浏览器专项），THR-03 升到 0.2.0 且运行时改为 `fsharp`
  （题目包只用 .NET 真实线程实现，不再混入 TypeScript 侧）。
- M1-06 新增 `scripts/trial.ts`（`pnpm trial`）：对 8 题各跑缺陷端与参考端，输出可执行状态与原始记录。

## Alternatives considered

- 用子代理并行产出 7 道题：试过并在长时间无产出后收回，改由主线按同一模板逐题实现、逐题验证，
  避免半成品互相覆盖。
- 把 F# 题改成 TypeScript：`dotnet fsi` 本机可用，改成 TS 会让 `runtime` 与题面失真，
  也会丢掉“真实线程”这一题目要点，因此保留 F#，只调整 THR-03 的运行时标注。
- 用计时断言性能：噪声大且与机器相关，改为访问计数断言复杂度，计时只作样本。
- 让隐藏检查导入工作区的公共辅助文件：候选可以改写它，因此每份检查自带辅助函数。

## Consequences

- 8 道试点现在都有真实资产与真实检查；题库仍是 55 道设计目录，其余 47 道没有夹具。
- F# 题没有内存原始样本（采样器只注入 node 命令）；这是执行层的已知缺口，已记录在试跑报告里。
- 缺陷端结论一律是 `check-failed`（没有被误判为超时或基础设施故障），说明分类没有把被测失败与平台故障混在一起。
- 8 题只产出可用验证的通过/失败，没有分数：代码质量评审接入前总分保持待定。

## Verification

- 每道题：`node scripts/task.ts verify <ID>` 六阶段通过（缺陷端只被声明检出项判失败、参考补丁与替代实现全过、隐藏资产不在导出里）。
- `node scripts/trial.ts`：8/8 通过，失败项与声明检出项逐题完全一致。
  明细见 [M1 试点试跑报告](../trials/2026-09-14-m1-pilot.md)，原始记录在 `data/trials/2026-09-14T06-21-13-611Z/`。
- `pnpm check`：exit 0（类型检查、55 题目录检查、53 项 vitest、生产构建）。
- 未完成：容器内执行、cgroup 限额与网络阻断；代码质量评审；7 道集成题与 Python 适配器。

