# Agent Note: 将 GRAPH-04 从静态遍历升级为图更新与诊断发布一致性任务

Status: implemented

## Problem

用户指出测试题可能过浅。GRAPH-04 0.1.1 的“极度困难”题只有静态反向可达性，
题名中的增量等价没有对应批次更新与状态发布机制，隐藏检查还复制公开样本。

## Decision

升级为 0.2.0，保留 Invalidator 回归，新增可复现的文档依赖批次变更、未解析引用、
累计待算、异步准备/失败重试和不可变诊断快照发布。来源依据为 cwtools-vscode 固定提交
`753a0d7c2df1f4285911febf2d10a949887f4499` 的 DiagnosticInvalidation、RefreshCoordinator、
Program 发布路径和 WorkspacePublication.Tests；源仓库只读。

增加 75 轮种子化全量 oracle 差分及受信回调计数，证明正确性与受影响工作量。
参考与替代采用不同索引/遍历/异步计算组织，3 个预声明近似错误补丁有独立检出证据。
移除 starter 中直接说明答案的缺陷注释与重复隐藏样本；题库总数量不变。

## Alternatives considered

- 单纯放大静态图：规模增加不能替代生命周期、依赖编辑与一致性推理。
- 将原 F# 整仓引入核心题：运行面和初始化噪声过大；原仓集成已另列，核心题提炼固定机制。
- 按补丁行数给极度困难背书：真实工程修复常很小；本次仅证明缺陷检出与契约成立，难度仍需真实作答校准。

## Consequences

题目同时约束图、派生诊断和发布权限；暴力全量重算无法满足回调工作量。
工作空间允许未解析依赖，而旧 Invalidator 仍保持未知节点报错，两个接口契约在题面分别说明。
这是单进程异步/重入任务，不冒充共享内存并发或完整 LSP 集成。
仍为 fixture-ready，不把开发验收说成正式模型成绩。

## Verification

`pnpm typecheck` 通过。
`node scripts/task.ts verify GRAPH-04` 的 6 阶段全部通过，starter 的 9 个预声明失败一致，
参考/替代各 17 个检查全部通过；记录 `data/task-runs/GRAPH-04/2026-09-14T10-51-27-594Z`。
`node scripts/mutants.ts GRAPH-04` 的 3 个有效近似错误补丁全部由预声明隐藏检查检出；
记录 `data/task-mutations/GRAPH-04/2026-09-14T10-51-31-714Z`。
固定来源 SHA-256、能力边界和详细检出说明见 [题目质量记录](../../../../graders/GRAPH-04/quality.md)。
未执行真实模型/裁判、Linux 容器或难度校准。

