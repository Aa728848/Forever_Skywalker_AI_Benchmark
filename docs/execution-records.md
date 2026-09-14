# 执行记录机制

采用两种相互关联的记录：面向开发者的 Agent Note，以及面向验证器的结构化运行证据。设计参考 `C:/Users/A/Documents/cwtools-vscode/.agents/notes/README.md`。

## 决策记录：当前已建立

路径：`docs/notes/{lifecycle}/{class}/YYYY-MM-DD-slug.md`。

- 生命周期仅为 proposed、implemented、rejected、archived。
- 分类仅为 feature、bug-fix、simplification、architecture、process、testing。
- 标题和正文用简体中文，保留 Problem、Decision、Alternatives considered、Consequences 四个章节。
- 非平凡变更和 Note 同批提交；implemented 写已经发生的事实及验证限制。
- 不维护全局 INDEX；目录负责索引，避免多人修改集中清单。

本项目沿用其状态和六类分类，将笔记放在可随文档阅读的 `docs/notes` 下。可以附 Verification 节记录命令、退出状态与已知缺口。完整模板见 [Agent Notes](notes/README.md)。

## 当前运行数据

API 将完整 `PreviewReport` 原子保存在 SQLite，包含生成时间、输入证据、题目 ID、候选哈希占位或实际输入值、规则版本、分项和结果。数据库默认 `data/benchmark.sqlite`；`BENCH_DB` 可显式指定路径，测试使用内存库或系统临时目录。

这些是调用者提供证据的评分预览，尚无 worker 证据认证、模型调用、作答过程或完整事件流。CLI 默认只输出 JSON/Markdown，不写入数据库。运行文件不提交到 Git，示例输入位于 `examples/assessment.json`，每条示例证据都标明没有真实执行或调用模型。

## 运行档案：当前实现

一次提交在已忽略的 `data/runs/` 下产生下列文件（`packages/runs` 与 `packages/executor` 写入）：

```text
data/runs/
  index.json                       # 幂等索引：幂等键 → runId/attemptId/摘要/冻结时间
  <taskId>/<runId>/<attemptId>/
    envelope.json                  # 平台校验过的提交信封
    freeze.json                    # 冻结记录：平台实算摘要、逐文件摘要、受控路径、提交者与时间
    manifest.json                  # 执行 manifest：题目包 manifest + 本次环境 + 候选摘要 + 信封
    events.jsonl                   # 控制面按顺序追加的事件流
    candidate/                     # 冻结快照（唯一被测对象）
    execution/
      workspace/                   # 从冻结快照物化的受控副本（本地档案含注入的 __checks__/）
      public.stdout.tap            # 公开检查的原始 TAP 输出
      public.stderr.txt            # 标准错误
      public.resources.json        # 资源采样原始数据（只对 node 命令生效）
      hidden.*                     # 隐藏检查同上
      execution.json               # 执行结论、逐项检查、资源数据与证据引用
      score.json                   # 正式评分：可用验证分项（质量缺失时 total=null）
```

事件包含 `schemaVersion`、稳定 `id`、单调递增 `seq`、UTC 时间、`type`、`actor`、`candidateHash`、`payload`、`evidenceRefs`；同一 `id` 只追加一次（重复完成事件不会重复记账）。持续时间由执行器用单调时钟测量，不依赖墙钟差值。

| 事件 | 现状 | 必需信息 |
| --- | --- | --- |
| run.created | 已实现 | 题目版本、执行档案、完成原因 |
| submission.frozen | 已实现 | 幂等键、base commit、候选 tree hash、文件数与字节数 |
| execution.started | 已实现 | 执行档案、隔离级别、产物目录 |
| check.finished | 已实现 | 阶段、退出码、信号、超时/取消、耗时、峰值 RSS、通过项与证据引用 |
| execution.finished | 已实现 | 结论、隔离级别、失败项与未运行项 |
| execution.reused | 已实现 | 复用已确认执行结果（重复完成事件或进程重启） |
| agent.completed | 未实现 | 适配器来源、完成原因、提交键（M2 的宿主适配器） |
| benchmark.sampled | 未实现 | 输入规模、重复轮次、耗时、吞吐、内存、校准标识（M2 的性能采样） |
| review.finished | 未实现 | 模型/参数、提示模板哈希、四维证据、调用错误与成本（M2 的裁判） |
| score.finalized | 已实现（可用验证分项） | 规则版本、分组权重、可用验证分与理由；代码质量与总分仍为 null，等裁判接入后补齐 |
| run.failed/cancelled | 未实现 | 责任域与可重试原因；目前取消与超时记在 check.finished 的 payload 里 |

尚未生成 `metrics.json`、`review.json`、`report.json`、`report.md` 与独立 `artifacts/` 目录：性能原始样本目前放在 `execution/*.resources.json`，执行输出与资源报告直接位于 `execution/` 下。这些文件随 M2 的评分与评审一起补齐。

事件由可信控制面写入；候选只可产生被采集的日志，不能写入评分事件。哈希用于检测内容变化，但仅有哈希链不能证明事件真实或阻止拥有全部写权限的人重写历史。发布级完整性依赖隔离写入身份及受保护的结果存储。

## 复核、重试与维护

基础设施重试保持相同候选哈希与题目环境档案，追加 retry 记录；修复代码后必须创建新 attempt。不同规则版本重评生成新报告并关联旧报告。人工复核保留原判决、复核身份、原因与时间。

日志控制长度并明确截断位置，脱敏凭据，保留足以复现错误的输入摘要。敏感原始数据不进入 Git；隐藏检查仅向用户报告公开验收要求和必要失败信息，不能输出全部保留数据。

每次发布需要一个完整的“题目 → 起始缺陷 → 参考补丁 → 检查结果 → 原始度量 → 裁判依据 → 分数”证据链。运行档案不代替源码与 Agent Note，Note 也不能代替机器执行证据。
