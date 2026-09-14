# Agent Note: 提交信封、候选冻结与幂等记录（M1-02）

Status: implemented

## Problem

M1-01 已经能导出候选工作区并跑检查，但平台还没有“接受一次提交”的机制：
谁提交了什么、平台实际收到哪一个快照、重复完成事件如何处理、冻结之后源目录被改动怎么办，
都没有可执行定义。M1-02 要求交付执行 manifest、提交信封、冻结候选快照与幂等提交记录，
判据是：同键同快照复用、同键异快照冲突、冻结后修改不改变被测对象。

## Decision

- `packages/contracts` 新增四个 0.1.0 文档类型，既有 Task、Assessment、ScoreResult、
  PreviewReport 与评分常量一律不动：
  - `SubmissionEnvelopeSchema`：runId、attemptId、taskId、taskVersion、baseCommit、
    candidateTreeHash、idempotencyKey、reason（agent-completed / operator-submit / patch-import）。
  - `FrozenAttemptSchema`：冻结记录，同时保留候选自报摘要与平台实算摘要、逐文件摘要、
    受控路径、排除项、提交者与时间。
  - `ExecutionManifestSchema`：题目包 manifest + 这一次 attempt 的环境（profile、
    nodeRange、镜像 digest、关闭外网、声明的工作目录）+ 候选摘要 + 信封原文。
  - `RunIndexSchema`：幂等键到已冻结 attempt 的索引。
- 新包 `@fsa/runs`（`packages/runs`）实现控制面：
  - 规范化树摘要：按相对路径排序、逐文件 sha256、再对清单求摘要，与磁盘时间无关；
    `.git` 与 `node_modules` 被排除并写入 `freeze.json.excluded`，不做静默丢弃；符号链接直接拒绝。
  - 平台重算：候选自报的 `candidateTreeHash` 必须等于平台实算值，否则拒绝；
    `baseCommit` 目前表示“题目包导出基线摘要”，平台每次重新导出题目包并核对，
    声明不符即拒绝。冻结副本还会再算一次摘要，确认收取内容与副本一致。
  - 幂等：索引按 `idempotencyKey` 查找。同键同摘要返回原 attempt（`reused`）；
    同键不同摘要抛 `IdempotencyConflictError`；同键跨题目抛冲突；
    已存在的 runId/attemptId 目录不能被其它键覆盖（`AttemptExistsError`）。
  - 冻结：先在 `<attemptId>.partial` 组装快照，再用 `renameSync` 原子落位，
    最后原子替换索引；中断只会留下 `.partial`，下次同键提交会先清理。
  - 物化：`materialize` 从冻结快照生成新的受控副本，并在复制前重算摘要，
    存储被改写时抛 `FrozenSnapshotTamperedError`。
- 存储布局（`data/runs`，已被 `.gitignore` 忽略）：
  `<taskId>/<runId>/<attemptId>/{envelope,freeze,manifest}.json` 与 `candidate/`。
- `scripts/run.ts` 提供演练入口 `submit / show / list / materialize`；
  正式的 `bench submit` 与来源认证入口仍留给 M1-04。

## Alternatives considered

- 把 runs 写进 SQLite：M0 的 SQLite 存的是预览报告，而执行记录设计要求
  `manifest.json / events.jsonl / execution.json` 这类可读文件，冻结对象本身又是目录；
  文件布局更贴合现状，也没有新增原生依赖。M1-03 采集运行指标时再决定是否落库。
- 采信候选自报的摘要与基线：违反“不能只采信候选自报哈希”，改为平台重算并交叉核对。
- 原地冻结（不复制候选目录）：无法满足“冻结后修改不改变被测对象”，也未采用。
- 用 mtime/大小做摘要：跨机器与复制不稳定，改为逐文件内容摘要。
- 在 M1-02 就执行检查并产出分数：属于 M1-03 的独立执行器与 M1-04 的自动触发，本次不做。

## Consequences

- 冻结快照是唯一被测对象；源工作区在提交后的任何修改都不会进入 verification。
- `baseCommit` 在 M1-02 是题目包导出基线摘要（64 位 hex），
  建立候选 git 仓库后（M1-04）应改为 commit 并保持“平台核对”的语义。
- 索引与 attempt 目录是单进程写入模型（与架构文档一致）；
  没有跨进程锁，也没有对 `data/runs` 的访问控制——正式运行的写入身份隔离属于 M1-03 之后。
- 本地演练使用 `profile: local` 且 `imageDigest: null`，只能证明冻结链路，
  不能当作容器隔离成绩；`linux-container` 档案在契约层要求必须固定镜像 digest。
- 本次仍不产出任何分数；代码质量评审接入前总分保持待定。

## Verification

- `pnpm check`：exit 0（类型检查、55 题目录检查、41 项 vitest、生产构建）。
  其中 `packages/runs/src/runs.test.ts` 13 项覆盖摘要确定性、排除项、冻结、幂等复用与冲突、
  跨题冲突、attempt 覆盖拒绝、冻结后修改无效、篡改检测与物化目标保护。
- 真机演练（`node scripts/run.ts`，候选目录来自 `node scripts/task.ts export CACHE-02`）：

  | 步骤 | 命令 | 结果 |
  | --- | --- | --- |
  | 首次提交 | `submit CACHE-02 <候选> --key rehearsal-demo-1` | 已冻结新 attempt，摘要 a0f629de…，4 文件 / 10340 字节 |
  | 同键同快照 | 同上 | 复用同一 run/attempt，索引仍为 1 条 |
  | 同键异快照 | 修改候选后同键提交 | exit 1：`同一幂等键收到不同快照` |
  | 新键提交 | `--key rehearsal-demo-2` | 已冻结第二个独立 attempt，摘要 73b518b8… |
  | 物化第一次冻结 | `materialize <runId> <attemptId> <空目录>` | 摘要与冻结记录一致；副本不含提交后的改动，源候选含该改动 |
  | 篡改冻结快照 | 改写 `candidate/` 后物化 | exit 1：`冻结快照摘要与冻结记录不一致` |

- 演练记录保留在已忽略的 `data/runs/`（索引 + 两个 attempt），可重复执行清理后重放。
- 未完成：独立执行器（M1-03）、自动触发与状态查询（M1-04）仍缺失；
  本次没有在容器内运行任何东西。
