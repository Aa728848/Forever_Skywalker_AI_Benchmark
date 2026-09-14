# Agent Note: 记录一致性、控制面事件流与首次提交

Status: implemented

## Problem

M1 的功能已经交付，但记录层还有几处与实现对不上：

1. 题目状态字段只允许 `designed`，于是生成的目录对 8 道已有真实夹具的题也写着“夹具未实现”，会误导接手的开发者。
2. `AGENTS.md` 仍写“当前为 M0”，与 roadmap、handoff 不一致。
3. `execution-records.md` 规定运行档案包含 `events.jsonl`、`metrics.json`、`review.json`、`report.*`，实现里一条都没有：
   控制面事件流完全缺失，档案目录也只是设计示例。
4. `baseCommit` 的语义没有写在协议里，容易被误读成 git commit。

## Decision

- 题目状态扩展为 `designed` → `fixture-ready` → `calibrating` → `ready`；8 道试点标为 `fixture-ready`，
  生成目录按状态渲染（“已有可执行夹具，尚未校准”），并新增回归测试：非 `designed` 的题必须有可校验的题目包，
  `designed` 的题不得存在 `manifest.json`，防止“加了夹具却没更新状态”或反之。
- `AGENTS.md` 更新到当前阶段，并把题目包结构、状态字段语义与各条检查命令（`pnpm check`、`task:verify`、`trial`、`test:e2e`）写进约定。
- 控制面事件流落地为 `<attempt>/events.jsonl`：
  - 协议新增 `RunEventSchema`（`schemaVersion`、稳定 `id`、单调 `seq`、UTC 时间、`type`、`actor`、`candidateHash`、`payload`、`evidenceRefs`）。
  - `packages/runs` 新增 `appendRunEvent` / `readRunEvents`：同 `id` 幂等、`seq` 单调递增；冻结时写 `run.created` 与 `submission.frozen`。
  - `packages/executor` 写 `execution.started`、每个阶段的 `check.finished`（退出码、信号、超时/取消、耗时、峰值 RSS、通过项）、
    `execution.finished`（结论、隔离级别、失败项与未运行项），复用已确认结果时写 `execution.reused`。
  - 事件 ID 带产物目录名，因此同一 attempt 的再次执行（显式新产物目录）不会覆盖上一次记录。
- `execution-records.md` 改为描述**当前实现**的目录布局与事件表，并逐条标注哪些事件尚未实现（`agent.completed`、
  `benchmark.sampled`、`review.finished`、`score.finalized`、`run.failed/cancelled`）以及哪些产物仍未生成
  （`metrics.json`、`review.json`、`report.json`、`report.md`、独立 `artifacts/`），避免文档继续承诺不存在的东西。
- `baseCommit` 语义写清楚：当前是**题面导出基线的摘要**（sha256，64 位 hex），由平台每次重新导出核对；
  建立候选工作区的 git 仓库后再改为 commit 并同时保留基线摘要。
- 首次把整个工作区提交进 Git（此前 M0 初始化文件一直是未跟踪状态）。

## Alternatives considered

- 把题目状态塞进题目包的 manifest 而不动题库协议：状态是**题库级**事实，写在 `catalog/tasks.json` 更合适，
  且能让目录生成与一致性测试共用同一个字段。
- 直接在 `doc` 里描述“最终设计”的档案布局：会让读者以为 `metrics.json`/`review.json` 已经存在；
  改为“当前实现 + 未实现清单”。
- 用墙钟时间做事件去重键：同一秒内的重复事件会互相覆盖，改为稳定 ID（类型 + runId/attemptId + 产物目录 + 阶段）。
- 现在就引入 git 仓库化的候选工作区：会改变 `baseCommit` 的校验方式（提交哈希不可复现），
  留到 M2 与候选 diff 一起做，本轮只把语义写清楚。

## Consequences

- 运行档案现在可追溯：`index.json`（幂等）→ `envelope.json` / `freeze.json` / `manifest.json`（是谁、冻结了什么、按什么环境执行）
  → `events.jsonl`（按时间顺序发生了什么）→ `execution/`（原始输出与资源数据）→ `execution.json`（结论与证据引用）。
- 事件流仍未与面板联动：M2 的正式时间线直接消费 `events.jsonl`。
- 事件只由可信侧写入，候选进程无法追加；但这仍是本地文件，拥有写权限的人可以重写历史，隔离写入身份留给发布阶段。
- 首次提交把仓库带入可回滚状态；后续每个执行项按同一粒度提交。
- 崩溃残留（`<attemptId>.partial`）现在会在每次成功提交后按年龄回收（默认 10 分钟以前），不会删除正在进行的提交。

## Verification

- `pnpm check`：exit 0。62 项 vitest（含新增：题目状态与题目包资产一致性、冻结事件流幂等与 seq 单调、执行事件序列）。
- `node scripts/catalog.ts --check`：55 题目录与元数据一致；生成目录中 8 行“已有可执行夹具”、47 行“夹具未完成”。
- 事件流实测：一次提交产生 `run.created`、`submission.frozen`（seq 1、2）；一次执行后追加 `execution.started`、
  两个 `check.finished`、`execution.finished`（seq 3–6）；重复完成事件追加 `execution.reused` 且只追加一次。
- `git log`：首次提交包含 8 道题目包、执行链路与全部文档；138 个文件纳入跟踪。
- 崩溃残留回收：单测写入 30 分钟前的 `attempt-crashed.partial` 与刚创建的 `attempt-running.partial`，前者被回收、后者保留。

