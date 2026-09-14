# Agent Note: 固定 cwtools 真实模块的 LSP 跨层集成题

Status: implemented

## Problem

INT-CWT 原来只有目录，需要在不改来源工作区的前提下提供固定提交、可离线复现、真正调用原模块的集成题。仅复制标题或重新模拟文档、协议、锁模块不能代表来源集成。

## Decision

通过只读 git show 提取 cwtools-vscode 提交 753a0d7c2df1f4285911febf2d10a949887f4499 的 Tokenizer、Parser、Ser、Types、DocumentStore、PathIdentity、Locking、DiagnosticInvalidation、RefreshLockPhases 及 Log。保留 MIT 许可、原文档回归源码和依赖版本声明，PROVENANCE.json 记录十四个来源文件的 SHA-256。

Types/Parser 使用原依赖 FSharp.Data 3.3.1。从本机已有 NuGet 缓存携带 netstandard2.0 DLL、包元数据、Apache 2.0 许可、两个 DLL 的 SHA-256 与原 NuGet SHA-512；执行期不拉取包。

新增薄 Pipeline 适配，合成编辑器发送真实 Content-Length JSON-RPC 字节流，调用原解析器、文档增量缓存、真实 F# 锁与失效跟踪，再发布确定性索引/诊断。起始版本只注入文本缓存版本判断和发布准入两处缺陷；参考恢复原缓存及精确生命周期/版本/admission 核对，替代使用模式匹配判断发布条件。公开检查保留上游 DocumentStore.Tests.fsx 的全部实际断言，仅改加载路径与报告包装。

## Alternatives considered

没有用自写假模块替代上游协议、缓存和锁。没有要求运行完整游戏分析器或整个 VSCode GUI，因为该独立集成题只承诺公开的跨模块协议链路；题面和报告明确边界，不把本题通过冒称为全仓测试通过。没有在原仓库安装、编辑或提交文件。

## Consequences

题包版本 0.1.0，具备 behavior/boundary/state/regression/resources 五组真实检查。二进制依赖使候选包约增加固定 DLL 大小，但无需容器运行期访问 NuGet。正式 Linux 隔离与发布校准仍须单独验证，宿主 FSI 结果只计本地证据。

## Verification

- `dotnet fsi tasks/integration/INT-CWT/starter/bootstrap.fsx`：真实原模块可加载，无在线 restore。
- 独立原模块基线：公开 4、隐藏 5 全部 exit 0，无缺失 ID；报告 `data/task-runs/INT-CWT/upstream-baseline/report.json`。
- `node scripts/task.ts verify INT-CWT`：六阶段通过；starter 恰好六个声明缺陷失败，reference/alternative 全部通过；证据 `data/task-runs/INT-CWT/2026-09-14T10-07-28-571Z`。
- 来源十四项与依赖两项 SHA-256 全部比对通过，可修改的 DocumentStore 使用受信原基线比对。
- `pnpm typecheck`：通过。未运行整个 cwtools 原仓测试，也未把本机结果记为容器成绩。
