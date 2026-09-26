# Agent Note: 测评并行：让作答、容器验证与裁判评分重叠

Status: implemented

## Problem

一次 55 题的真实实验（`exp-2026-09-26T11-21-31-129Z-32e16e34`）耗时 **259 分钟**。分解后：

| 环节 | 耗时 | 占比 |
| --- | --- | --- |
| 作答（模型） | 120 分钟 | 46% |
| 容器验证 + 两轮裁判 + 归档 | 139 分钟 | 54% |

`runDshComparison` 的主循环是 `for (const row of report.rows)`，逐条走完
「作答 → 容器验证 → 裁判评分」，因此这三类工作**从不重叠**：模型在思考时容器闲置，
容器在跑时模型闲置。单题作答中位 103 秒、最长 9.2 分钟；每题还有两次独立的裁判会话。

## Decision

1. `DshComparisonOptions` 新增 `concurrency`（1–8，默认 1）。1 就是原来的串行行为，逐字不变。
   主循环改为固定大小的 worker 池：`Math.min(concurrency, 待执行行数)` 个 worker 不断取下一行。
2. 停止语义从 `break` 改为**停止标记**。串行时一个 `break` 就能立刻停，并行时不行：
   在飞行的行必须收尾（否则 workspace 与证据会半截）。现在 `requestStop()` 只阻止**派发新行**，
   已开始的行在 `runRow` 的 `finally` 里跑完。取消仍判 `cancelled`，失败仍判 `failed`。
3. 报告落盘改为**唯一临时名 + Promise 链串行**。原来固定用 `experiment.json.tmp`，
   并发写会互相覆盖临时文件，两次 rename 也可能乱序，让较旧的完整快照盖掉较新的。
4. 落盘链**有界**：返回前排空（`drainPersist`），排空后关闭（`persistClosed`），
   关闭之后 `persist()` 是空操作。少了这一步，链上的写入会跑到 `runDshComparison` 返回之后，
   在调用方（尤其是测试）删掉输出目录后抛 `ENOENT` 未处理拒绝——实测 8 个测试各出一条。
5. CLI `--concurrency <1-8>`、API `concurrency` 字段、网页「并行度」输入框。
   续跑时并行度同样取自报告 `settings`，与既有配置一致性核对一起生效。

## 隔离前提（都已成立，不因并行而改变）

- 每题一个独立 workspace：`<scratch>/workspaces/<sessionId>`
- 每题一个唯一容器名：`fsa-<uuid>`，独立 workspace 挂载
- 每题一个独立 DSH 会话：`sessionId` 唯一，作答与两轮裁判各自独立
- 每题一个独立裁判实例：`createDshJudgeFromEnvironment` 在 `reviewCompletedAttempt` 内部新建。
  （此前我误判裁判适配器内的 `queue` 是**跨题**瓶颈；它实际只序列化**同一题的两轮**，
  因为实例是每题新建的。故未改动该队列。）
- 行级写入无冲突：一条 row 只被一个 worker 处理

## Alternatives considered

- **放开裁判适配器的串行队列**：基于「队列是跨题瓶颈」的误判。查清实例是每题新建后，
  该队列只影响题内两轮，不构成跨题瓶颈，因此不改——避免为不存在的收益动评分路径。
- **把题内两轮也并行**：能再省一点，但两轮是同一题的独立判决，串行便于在失败时保留第一轮证据；
  本轮不做，等并行主循环的实测数据出来再评估。
- **无上限并行（每题一个 worker）**：55 题同时打向同一份模型配额，限流与容器争用都会上升，
  且失败时会浪费大量在飞行的作答；改为上限 8。
- **把 persist 改成完全异步、不等待**：正是产生未处理拒绝的做法，弃用。

## Consequences

- 默认 `concurrency: 1`，既有实验的耗时与行为完全不变；并行必须显式开启。
- 并行时进度日志会交错（每条自带时间戳与题目），阶段的先后顺序不再严格等于行的顺序。
- 报告里记录 `settings.concurrency`，事后可判断某次实验是否并行过。
- 结果可比性不受影响：题目、预设、等级、容器、裁判都与串行时相同，只是调度重叠。

## Verification

- **并行的直接证据**：`dsh-comparison.test.ts` 记录「同时在飞」的峰值——串行 `peak === 1`、
  3 路 `peak === 3`，且 3 路墙钟显著短于串行；结果完整性（`state === 'completed'`、行数）不变。
- 越界拒绝：`--concurrency 0`、`9`、`2.5` 均报「并行度须为 1–8 的整数。」
- CLI 接受：`--concurrency 3 --check` 通过本地预检，模型调用 0。
- 网页控件：并行度输入框默认 1，输入 99 夹到 8、输入 0 夹到 1。
- 无未处理拒绝：修复前 evaluation 套件报 8 条 `ENOENT ... .tmp` 未处理拒绝，修复后 0 条。
- `pnpm check` exit 0（377 项）。