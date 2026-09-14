# Agent Note: 正式提交入口与运行状态查询（M1-04）

Status: implemented

## Problem

M1-02 能冻结候选、M1-03 能执行检查，但还没有任何入口把两者串起来：
提交必须由人手工转录分数，重复完成事件与进程重启会不会重跑已确认的副作用没有定义，
查询侧也只有预览报告，看不到当前阶段、已知失败、可重试原因与证据引用。
M1-04 的判据是：一次提交无需人工转录分数即可完成可用验证；重启或重复事件不重复执行已确认副作用。

## Decision

- `packages/contracts` 新增 `RunSubmissionSchema`（正式入口请求体）与 `RunStatusSchema`
  （阶段、执行结论、已知失败、缺失检查、可重试原因、证据引用与 artifact 摘要，
  `scoring.mode` 固定为 `pending`）。
- `packages/executor`：
  - `verifySubmission`：提交（幂等）→ 若已有 `execution.json` 直接复用，否则执行；
    返回 `reusedExecution`，重复完成事件与进程重启都不会重跑检查。
  - 崩溃残留处理：执行产物目录存在但没有结果时改用 `execution-2`、`execution-3`，不覆盖上次证据。
  - `readExecutionResult` / `readRunStatus` / `listRunStatuses`：查询输出只读已落盘的冻结记录与执行结果。
  - 可重试只对 `infrastructure-error` 与 `cancelled` 开放，且声明只允许同一快照重试；
    被测失败（check-failed/timeout/memory-exceeded）不自动重试。
- `packages/runs` 新增 `createEnvelope`，CLI、API 与演练脚本共用同一套 baseCommit/候选摘要实算逻辑。
- `apps/cli`：新增正式入口 `bench submit <题目> <候选目录> --key <幂等键>` 与 `bench status`、`bench runs`；
  保留 `bench score`、`/api/previews` 的预览语义不变（预览不执行候选代码）。
- `apps/api`：`POST /api/runs`（需要 `x-bench-token`，候选目录必须位于 `BENCH_SUBMISSIONS_DIR` 之内）、
  `GET /api/runs`、`GET /api/runs/:runId/:attemptId`；`/api/health` 如实报告
  `runEntry`、`isolatedExecution: false`、`judgeConnected: false`。

## Alternatives considered

- 把提交放进队列异步执行：当前是单用户本地面板，同步执行一次提交在 60 秒级预算内可接受；
  队列、进度订阅与取消留给需要并发作答的后续阶段。
- 用 `mode: 'formal'` 之类的字符串代替真正的受控链路：违反“不能把 mode 改成 formal 就宣称可信”，
  本实现的可信度来自冻结快照、平台重算摘要与受控命令，而不是字段命名。
- 允许 API 接受任意绝对路径：会把任意目录执行权暴露给 HTTP 调用方，改为提交根目录内的相对路径约束。
- 无认证的本地入口：文档要求正式入口有来源认证；未配置令牌时入口直接禁用（503），而不是默认放开。
- 重试时覆盖上次产物：会让证据链丢失，改为新的产物目录。

## Consequences

- API 的提交请求会阻塞到验证结束（每题两阶段、每阶段最多 `limits.timeoutMs`）；
  没有取消接口，取消只能由 CLI 侧的 AbortSignal 触发。
- 运行记录是 `data/runs` 下的文件（单写者模型），仍是本机开发环境；容器与多用户隔离未接入。
- 为了让协议支持 F# 题目与更准确的运行时描述，本阶段把 `TaskManifest.nodeRange` 改名为 `runtimeRange`、
  把执行结果的 `nodeVersion` 拆成 `platformVersion` 与 `candidateRuntimes`，并把题目版本从字面量放开为语义化版本串。
  改名后此前用旧字段写下的演练记录不再可读，这些开发期临时数据已删除并按新协议重建。
- 总分仍然待定：代码质量评审未接入，运行状态只报告可用验证的检查结论。

## Verification

- `pnpm check`：exit 0。53 项 vitest（core 18、runs 13、tasks 9、executor 9、api 4）与生产构建通过。
- 单元与集成测试覆盖：重复完成事件与“进程重启”（同一存储目录新建 store）都复用同一次执行结果、
  冻结未执行的状态为 `frozen` 且无分数、API 未配置时 503 / 无令牌 401 / 越界路径 400 / 未知运行 404、
  重复请求不产生第二条运行记录。
- 真机演练（`pnpm bench`，CACHE-02 缺陷候选）：

  | 命令 | 结果 |
  | --- | --- |
  | `bench submit CACHE-02 <候选> --key m104-demo` | 已冻结新 attempt，执行结论 `check-failed`，列出 4 个已知失败（含关键项），可重试=否，总分待定，证据 6 项；退出码 1 |
  | 同键重复提交 | 复用同一 run/attempt 且复用已确认执行结果 |
  | `bench runs` | 只有一条运行记录 |
  | `bench status <runId> <attemptId>` | 与提交时一致的状态与证据 |

- 未完成：容器内执行、取消/进度 API、前端正式运行时间线（M2）、质量评审与分数。
