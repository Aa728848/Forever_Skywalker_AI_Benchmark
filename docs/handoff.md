# 开发交接与执行手册

交接日期：2026-09-14。交接状态：M1-01 至 M1-06 已全部交付并验证；M1-03 的容器档案代码也已实现并接线，唯一未完成项是**在真实容器里跑一次**（本机没有容器运行时）。M2 尚未开始。

本文供下一位开发者或 AI 直接接手执行。需求与技术路线已由用户确认，常规实现继续按既定方案推进；只有实际扩大范围或改变评分契约时才重新对齐。

## 1. 接手结论

当前项目可以查看题库、计算调用者提供证据的评分预览、保存预览报告，并且已经在 CACHE-02 上具备第一份真实题目包与可执行的正反对照。**尚不能接收 AI 开发结果并独立验证、评分。** 下一阶段的目标是实现 M1：首批 8 道真实任务及受控执行链。

M1-01 已完成：CACHE-02 具备冻结的公开接口、缺陷 starter、公开与隐藏检查、参考补丁和结构不同的替代实现，三向验证通过，详见 [M1-01 Note](notes/implemented/feature/2026-09-14-cache-02-task-package.md)。

M1-02 已完成：提交信封、执行 manifest、候选快照冻结与幂等提交记录已可运行，同键同快照复用、同键异快照冲突、冻结后修改不影响被测对象均有真实演练证据，详见 [M1-02 Note](notes/implemented/feature/2026-09-14-submission-freeze-control-plane.md)。

M1-03 已交付执行器部分：从冻结快照物化被测对象、按题目包固定命令运行公开与隐藏检查、自己解析结果、区分超时/内存耗尽/取消/基础设施故障，参考补丁通过、缺陷候选失败均有真机证据，详见 [M1-03 Note](notes/implemented/feature/2026-09-14-minimal-executor-and-fault-classification.md)。**容器内执行未完成**：本机 `docker`、`podman` 均不在 PATH，WSL 未安装，`linux-container` 档案会被执行器直接拒绝，不会用宿主结果冒充隔离成绩。

M1-04 已完成：`bench submit` 是正式提交入口（需要 `x-bench-token` 与提交根目录约束），一次提交自动完成冻结与验证，重复完成事件与进程重启都复用已确认结果；`bench status` / `bench runs` 与 `GET /api/runs` 提供阶段、已知失败、可重试原因与证据引用，详见 [M1-04 Note](notes/implemented/feature/2026-09-14-submit-entry-and-run-status.md)。

M1-05 与 M1-06 已完成：其余 7 道试点（FE-01、LSP-01、BND-02、THR-03、GRAPH-03、CONC-04、PERF-04）与 CACHE-02 一样具备真实题目包与受信资产，8 题试跑全部满足“参考通过且缺陷被拦住”，报告见 [M1 试点试跑报告](trials/2026-09-14-m1-pilot.md)、记录见 [M1-05/06 Note](notes/implemented/feature/2026-09-14-m1-pilot-pack-and-trial.md)。

工作目录：`C:/Users/A/Documents/ChatGPT/Forever_Skywalker_AI_Benchmark`。

交接时初始化文件仍显示为 Git 未跟踪文件；没有为 M0 创建提交或推送。接手先检查工作区，不能把这些文件当作临时产物清理。

## 2. 已确认的约束

| 事项 | 执行约束 | 事实来源 |
| --- | --- | --- |
| 使用方式 | AI 在独立任务仓库开发，完成信号或补丁触发验证 | [需求](requirements.md) |
| 题库 | 48 道核心题覆盖 12 域 × 4 级；7 道原仓库集成题单独报告 | [题目目录](task-catalog.md) |
| 评分 | 可用验证 50、代码质量 50；代码四维各 12.5 | [评分标准](scoring.md) |
| 合格门槛 | 总分 ≥70、可用分 ≥40、关键项全过 | [评分标准](scoring.md) |
| 分级 | 核心四级权重 10/20/30/40；缺测不能重新归一化成完整成绩 | [评分标准](scoring.md) |
| 技术栈 | TypeScript、Node 24、pnpm workspace、React/Vite、Fastify、SQLite | [架构](architecture.md) |
| 环境 | Windows 开发；固定 Linux 容器正式执行；Windows/LSP 分列 | [架构](architecture.md) |
| 来源仓库 | 只读取材；在独立副本出题和运行，不改原工作区 | [来源版本](source-projects.md) |
| 记录 | 非平凡变更附中文 Agent Note；运行证据另行结构化记录 | [记录机制](execution-records.md) |

前序确认记录和实际验收见 [M0 架构 Note](notes/implemented/architecture/2026-09-14-benchmark-initialization.md)。需求正文、评分正文、题目元数据分别拥有各自事实；本文负责执行顺序，不能用交接说明偷偷修改它们。

## 3. 当前代码与能力位置

| 位置 | 已实现 | 接手时的注意点 |
| --- | --- | --- |
| [contracts](../packages/contracts/src/index.ts) | Task、Assessment、PreviewReport 协议与评分常量 | Task 状态仅允许 designed；Assessment/Report 仅允许 preview |
| [core](../packages/core/src/index.ts) | 证据引用检查、50/50 计算、单题门槛、四级汇总 | 不验证证据真实性；不执行进程、网络或模型调用 |
| [catalog](../packages/catalog/src/index.ts) | 目录读取、ID 与四级覆盖检查 | 校验当前 48/55 规模；不要为只运行 8 题而删减目录 |
| [题目元数据](../catalog/tasks.json) | 55 题的问题、不变量、公开/隐藏检查计划及来源定位 | 全部是设计规格，没有 starter、参考补丁或可执行检查 |
| [来源清单](../catalog/sources.json) | 七个项目提交、运行时与证据路径 | 原仓库完整测试尚未执行 |
| [CLI](../apps/cli/src/main.ts) | list、show、score，支持 Markdown 预览输出 | 还没有 submit、run、status 等正式执行命令 |
| [API](../apps/api/src/app.ts) | health、tasks、previews 查询与预览写入 | 没有任务队列、完成事件入口或执行器调度 |
| [存储](../apps/api/src/store.ts) | SQLite 原子保存与读取预览 | 预览存储；正式运行记录是 `data/runs/` 下的文件（见 [执行记录机制](../docs/execution-records.md)），两者分开 |
| [Web](../apps/web/src/main.tsx) | 题目筛选、预览报告及证据查看 | 没有正式执行时间线；示例分数必须继续标为预览 |
| [目录生成器](../scripts/catalog.ts) | 元数据生成 Markdown，一致性检查 | 修改目录后运行 catalog:docs，不直接改生成文件 |
| [题目包支撑](../packages/tasks/src/index.ts) | manifest 校验、白名单导出、受信检查执行与三向验证 | 导出只认 manifest 白名单；隐藏资产必须位于题目包之外 |
| [CACHE-02 题目包](../tasks/core/CACHE-02/) | task.md、manifest.json、缺陷 starter、公开检查 | 只有这一题有真实资产，其余 54 题仍是设计规格 |
| [CACHE-02 受信资产](../graders/CACHE-02/README.md) | 隐藏检查、参考补丁、替代实现与独立验证计划 | 不进入候选工作区，只由受信侧在导出后注入 |
| [题目包 CLI](../scripts/task.ts) | task:export 与 task:verify，用 node 运行 | 还不是正式执行器；只在开发机验证题目包本身 |
| [提交与冻结控制面](../packages/runs/src/index.ts) | 候选树摘要、提交信封校验、冻结快照、幂等索引、事件流与物化 | 不做隔离执行，也不决定分数；单进程写入模型 |
| [正式评分桥](../packages/core/src/index.ts) | `scoreExecution`：执行结果 → 可用验证分组分（质量缺失时总分待定） | 纯函数，不读文件/网络，不调用模型 |
| [演练入口](../scripts/run.ts) | submit / show / list / materialize / execute | 非正式入口；`bench submit` 与来源认证属于 M1-04 |
| [最小执行器](../packages/executor/src/index.ts) | 物化被测对象、运行固定命令、解析检查、故障分类与资源采样 | 不决定分数；`profile=local` 时没有隔离与网络阻断 |
| [试点题目包](../tasks/core/) | 8 道题各有 task.md、manifest.json、缺陷 starter、公开检查与受信资产 | 其余 47 道仍是设计规格，不是可执行题目 |
| [试跑脚本](../scripts/trial.ts) | 对 8 题各跑缺陷端与参考端，输出可执行状态与原始记录 | 只跑本机 profile=local，不产生分数 |

正式执行器、完成适配器、参考解、隐藏用例、真实性能采样、模型裁判及人工复核流程都未实现。现有 `examples/assessment.json` 的 85 分来自假设输入，不能作为任务参考解通过的证据。

### 首次接手检查

先阅读根目录 [AGENTS.md](../AGENTS.md)，然后执行：

```powershell
Set-Location -LiteralPath 'C:\Users\A\Documents\ChatGPT\Forever_Skywalker_AI_Benchmark'
git status --short --branch
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm check
```

涉及界面或 API 流程再执行：

```powershell
pnpm browsers:install
pnpm test:e2e
```

需要手动查看时运行 `pnpm dev`，面板端口 4317、API 端口 4318；先结束自己的开发实例，再运行端到端测试，测试不会复用占用中的服务。

上次已通过的基线：类型检查、55 题目录检查、20 项核心/API 测试、生产构建、CLI 预览、1 项浏览器端到端测试。这是前序 M0 验收结果，不代表每次交接都重新运行过。

本次实际通过：`pnpm check`（类型检查、55 题目录检查、41 项 vitest 测试、生产构建）、`pnpm test:e2e`（1 项浏览器端到端）、`node scripts/task.ts verify CACHE-02`（六阶段全通过）、`node scripts/run.ts` 提交与冻结演练（8 步，含 2 个预期失败路径）。受限沙盒下 tsx/vitest 不可用时改跑 `node scripts/catalog.ts --check` 与 `node scripts/task.ts verify`，见 §5。

## 4. M1 执行队列

M1 的六个执行项全部交付：M1-01、M1-02、M1-04、M1-05、M1-06 完成，M1-03 完成了执行器部分但容器内执行未验证。剩余工作是容器档案与 M2；不要用宿主结果冒充隔离成绩。

| 编号 | 依赖 | 必须交付 | 完成判据 |
| --- | --- | --- | --- |
| M1-01 | 基线检查 | CACHE-02 题目包、固定接口、缺陷 starter、公开检查、参考补丁、独立验证计划 | 起始缺陷可被检查检出，参考修复与替代实现满足同一契约 |
| M1-02 | M1-01 | 执行 manifest、提交信封、冻结候选快照、幂等提交记录 | 同键同快照复用；同键异快照冲突；冻结后修改不改变被测对象 |
| M1-03 | M1-02；Linux 容器环境 | 最小独立执行器、资源/网络约束、可信检查结果、退出和回收 | 参考补丁实测通过；缺陷补丁失败；超时、OOM、取消和基础设施失败可区分 |
| M1-04 | M1-03 | CLI 显式完成/提交入口自动触发验证，API 可查询状态和证据 | 一次提交无需人工转录分数即可完成可用验证；重启或重复事件不重复执行已确认副作用 |
| M1-05 | CACHE-02 闭环已验收 | 其余 7 道试点及必要 Node/.NET 适配 | 每题有正反对照、真实检查、固定环境和原始证据 |
| M1-06 | M1-05 | 8 题试跑报告、难度与成本初步校准、M2 交接更新 | 每题明确可执行状态和问题；不输出伪装成 48 题完成的核心总分 |

M1 不以模型裁判已接入为前提。缺少代码客观分或独立评审时，沿用现有缺失规则：保留已有可用证据，总分待定。完整自动评分在 M2 补齐证据链后验收，不能用固定评语或示例质量分填补。

### M1-01：先制作 CACHE-02（已完成，2026-09-14）

这道题要求“同键加载合并与失败恢复”，至少冻结以下公开行为：

1. 同键并发只调用一次实际加载器，调用者获得符合契约的结果。
2. 加载失败后不永久缓存 rejected Promise；下一次请求可以重新尝试。
3. 不同键可以并发加载，不能为避免竞争而将所有加载串行化。

参数、返回值、失败传播、键身份与清理语义必须先写在题面中，再写隐藏检查。不得为了实现方便顺带要求其他缓存能力或改动原仓库缓存。

第一版任务包只为这一题建立必要结构。可采用下列路径；这些是待创建的建议路径，不是当前已存在的能力：

```text
tasks/core/CACHE-02/
  task.md                 # 对 AI 可见的需求、接口与限制
  manifest.json           # 运行时、固定命令、检查 ID 和资源预算
  starter/                # 独立且可启动的缺陷项目
  public-tests/           # 随候选工作区发布的公开检查
graders/CACHE-02/
  checks/                 # 仅可信验证侧持有的检查
  reference.patch         # 参考修复，不能随候选工作区导出
```

参考与隐藏资产应由平台导出逻辑排除，不能仅依靠目录名字暗示保密。检查使用可控的 deferred/barrier 调度构造重叠，不靠任意 sleep 碰撞。保留错误解和参考解的实际结果；替代实现用于证明检查没有绑定某一种代码结构。

**完成记录（2026-09-14）**

- 产物：`tasks/core/CACHE-02/{task.md,manifest.json,starter,public-tests}`、`graders/CACHE-02/{checks,reference.patch,alternative,README.md}`、`packages/tasks`、`scripts/task.ts`，协议新增 `TaskManifestSchema`。
- 导出白名单是 manifest 的 `workspace.entries`：候选工作区只有 TASK.md、package.json、starter 与 public-tests；隐藏检查由受信侧在导出后注入 `__checks__/`，manifest 校验还会拒绝把隐藏资产放进题目包。
- 实际命令与结果：`node scripts/task.ts verify CACHE-02` exit 0；起始缺陷只被声明的 4 个检出项判失败（2 个公开、2 个隐藏），参考补丁与替代实现在公开与隐藏检查上全部通过。
- 未完成：Linux 容器执行、冻结快照、完成事件入口（M1-02 至 M1-04）；容器与隔离执行链不存在，本次检查全部来自本机。
- Agent Note：`docs/notes/implemented/feature/2026-09-14-cache-02-task-package.md`。

### M1-02 至 M1-04：首道可用验证闭环

先实现一个受控 Node 任务的必要路径，再按试点需求扩展，避免提前建立通用工作流框架。

输入输出必须明确：

- 平台维护的执行 manifest：任务/协议版本、starter 摘要、运行时与镜像 digest、工作目录、命令 argv、检查 ID/权重、超时/CPU/内存/网络限制。
- 提交信封：runId、attemptId、taskVersion、baseCommit、候选 tree hash、idempotencyKey、完成原因；具体 Schema 在 contracts 统一维护。
- 冻结记录：实际收取的补丁或快照摘要、受控路径、提交者与时间；不能只采信候选自报哈希。
- 执行输出：检查结果、退出原因、资源原始数据、候选哈希与证据引用。候选 stdout 的 PASS 不能直接变为通过结论。
- 查询输出：当前阶段、已知失败、可重试原因和已有证据。评审未接入时总分仍为待定。

正式的 `bench submit` 等命令及运行 API **尚不存在**。实现时保留现有 `bench score` 与 `/api/previews` 的预览语义，另设有来源认证的正式运行入口；不能把 `mode` 字符串改成 formal 就宣称可信。

题目执行状态需要扩展时，同时更新 Schema、消费者与相关测试；现有 0.1.0 数据不得被静默解释成新协议。把“完整 55 题目录检查”与“当前选择的 8 题执行集”分开，后者不应改变题库规模。

需要优先验证的故障路径：重复完成事件、提交后文件修改、旧 attempt 迟到结果、执行器启动失败、候选自身崩溃/超时、取消时后代进程回收、控制进程重启后的状态恢复。

**M1-02 完成记录（2026-09-14）**

- 产物：`packages/runs`（摘要、冻结、幂等、物化）、`scripts/run.ts`、`data/runs` 存储布局（已忽略）；协议新增 `SubmissionEnvelopeSchema`、`FrozenAttemptSchema`、`ExecutionManifestSchema`、`RunIndexSchema`。
- 平台不采信候选自报：`candidateTreeHash` 与 `baseCommit` 都由平台重算核对，冻结副本再复核一次摘要；物化前重算摘要可发现存储被改写。
- 实际命令与结果：`node scripts/run.ts submit CACHE-02 <候选> --key rehearsal-demo-1` 冻结摘要 `a0f629de…`；重复同键返回 `reused`；修改候选后同键 exit 1（同键异快照冲突）；新键产生第二个独立 attempt；物化副本与冻结记录一致且不含提交后修改；篡改 `candidate/` 后物化 exit 1。
- 未完成：独立执行器、资源与网络约束、自动触发与状态查询（M1-03、M1-04）；本次没有任何容器内执行。
- Agent Note：`docs/notes/implemented/feature/2026-09-14-submission-freeze-control-plane.md`。

**M1-03 完成记录（2026-09-14，容器部分未完成）**

- 产物：`packages/executor`（`executeAttempt` / `runPhase` / `classifyExecution` / 受信资源采样器）、`scripts/run.ts` 的 `execute` 子命令；协议新增 `ExecutionResultSchema` 与执行结论枚举。
- 可信结果：被测对象只来自冻结快照的受控物化，隐藏检查由受信侧在物化后注入；检查结论只来自平台自己解析的 TAP，并按 manifest 声明的检查 ID 对齐，对不上的记为 not-run。
- 实际命令与结果：`node scripts/run.ts execute <runId> <attemptId>` 在 `data/runs-rehearsal/` 上得到 `check-failed`（缺陷候选，恰好 4 个声明检出项失败）、`passed`（参考补丁候选，摘要不同于缺陷候选）、`timeout`（60s 预算耗尽，public 阶段被终止）、`cancelled`（2s 后中止）、`memory-exceeded`（exit=134）；命令不存在的 `infrastructure-error` 由单元测试覆盖。
- 回收：超时与取消后核对系统进程表，没有遗留 `--test` 子进程；同一 attempt 的既有产物不会被覆盖。
- 未完成：容器内执行、cgroup 级 CPU/内存限额与网络阻断；本机 `docker`/`podman`/WSL 都不可用，`linux-container` 档案被显式拒绝。
- Agent Note：`docs/notes/implemented/feature/2026-09-14-minimal-executor-and-fault-classification.md`。

**M1-04 完成记录（2026-09-14）**

- 产物：`packages/executor` 的 `verifySubmission` / `readRunStatus` / `listRunStatuses`，`packages/runs` 的 `createEnvelope`，`apps/cli` 的 `bench submit|status|runs`，`apps/api` 的 `POST /api/runs`、`GET /api/runs`、`GET /api/runs/:runId/:attemptId`；协议新增 `RunSubmissionSchema` 与 `RunStatusSchema`。
- 实际命令与结果：`pnpm bench submit CACHE-02 <候选> --key m104-demo` 自动完成验证并列出 4 个已知失败、可重试=否、总分待定；同键重复提交复用同一 attempt 与同一次执行结果；`bench runs` / `bench status` 输出一致。
- 未完成：容器内执行、取消/进度 API、前端正式运行时间线（M2）。
- Agent Note：`docs/notes/implemented/feature/2026-09-14-submit-entry-and-run-status.md`。

**M1-05 与 M1-06 完成记录（2026-09-14）**

- 产物：`tasks/core/{FE-01,LSP-01,BND-02,THR-03,GRAPH-03,CONC-04,PERF-04}` 与 `graders/<ID>/` 全套资产；`scripts/trial.ts`（`pnpm trial`）；报告 `docs/trials/2026-09-14-m1-pilot.md`。
- 运行时：TypeScript 题走 `node --test`；LSP-01 与 THR-03 是 F# / .NET 10，检查脚本由 `dotnet fsi` 运行并自行打印 TAP。
- 实际命令与结果：每题 `node scripts/task.ts verify <ID>` 六阶段通过；`node scripts/trial.ts` 8/8 通过，缺陷端失败项与声明检出项逐题完全一致。
- 未完成：容器内执行；代码质量评审与分数；7 道集成题与 Python 适配器（M3）。
- Agent Note：`docs/notes/implemented/feature/2026-09-14-m1-pilot-pack-and-trial.md`。

**M1-03 容器档案完成记录（2026-09-14，实跑待容器运行时）**

- 产物：`packages/executor/src/container.ts`（镜像引用校验、运行时与镜像探测、`docker run` 参数构建、docker 失败码识别）；执行器引入 `PhaseTransport`，本地与容器档案共用同一阶段运行器；协议新增 `image`、`containerRuntime`。
- 行为：`linux-container` 必须同时给出镜像引用与 digest；执行前 `docker image inspect` 校验本地固定镜像，**执行期不拉取**；容器以 `--network none`、`--cpus`、`--memory/--memory-swap`、`--pids-limit` 限额运行；隐藏检查以只读方式挂载在 `/work/__checks__`，不复制进候选树。
- 实际命令与结果：`pnpm check` exit 0（61 项 vitest，含容器参数的 8 项单元测试）；演练提交容器档案后 manifest 记录 `profile=linux-container image=… digest=… network=False`，执行以 `容器运行时不可用（docker version 退出码 null）` 拒绝且未退回宿主；缺镜像引用时提交被拒；连续三次 `pnpm trial` 8/8。
- 未完成：真实容器内跑一次（runbook 见 Agent Note）；`--read-only` 根文件系统、非 root 执行身份等加固项同样留到实跑时验证。
- Agent Note：`docs/notes/implemented/feature/2026-09-14-container-profile-and-pinned-image.md`。

### M1-05：其余试点顺序

| 题目 | 能力重点 | 独立证据要求 |
| --- | --- | --- |
| FE-01 | 状态、错误恢复与基本可访问性 | 浏览器操作可达，重复重试不重复追加 |
| LSP-01 | JSON-RPC 消息边界 | 实际协议字节流；多字节字符、拆包和截断 |
| BND-02 | 裁判输出和嵌套参数解析 | 确定性解析检查；不需要真实模型才能制作题目 |
| THR-03 | 读写锁与锁外回调 | 真实线程与屏障；不能用 Promise 并发冒充线程验证 |
| GRAPH-03 | 深层 AST 与栈安全 | 深层输入、浅层差分参考和公开错误语义 |
| CONC-04 | 续跑与副作用去重 | 固定检查点、重复/乱序事件及崩溃恢复 |
| PERF-04 | 长会话重放效率 | 同机参考与候选的原始样本；正确性先通过 |

每题都先核对 [目录规格](task-catalog.md)，再读取 [固定来源](source-projects.md) 的目标代码。临时发现的新能力不自动进入试点范围。

## 5. 已知环境问题与处理边界

| 问题或缺口 | 已知事实 | 接手处理 |
| --- | --- | --- |
| Docker | 2026-09-14 再次核实：`docker`、`podman` 都不在 PATH，WSL 未安装，没有任何可用容器运行时；容器档案代码已实现并通过单元测试与拒绝路径演练 | 有运行时后按 [容器档案 Note](notes/implemented/feature/2026-09-14-container-profile-and-pinned-image.md) 的 runbook：预载固定 digest 的镜像 → `pnpm bench submit --profile linux-container --image … --image-digest …` → `BENCH_PROFILE=linux-container pnpm trial`。在此之前不要宣称隔离成绩，也不要给容器档案填假 digest |
| SQLite | Node 24.14.1 的内置 API 有实验性提示 | 当前可用且测试通过；正式发布前按固定运行时验证，暂不为此重写存储 |
| 第三方原生 SQLite 驱动 | 曾因缺少 C++ 工具链安装失败，现已移除 | 不重新引入原生构建依赖来解决不存在的新问题 |
| Playwright | 固定浏览器放在 .cache/playwright；自定义路径由环境变量控制 | 用现有安装脚本，首次或缓存缺失时安装 |
| Windows 测试进程 | 沙盒内曾无法正常清理子进程，完整进程权限下已通过 | 使用运行环境提供的正常权限流程；终止前核对本任务命令行，不能按历史 PID 或全部 node 进程批量结束 |
| 裁判模型 | 没有接入模型、没有配置实际调用预算 | M1 的确定性测试继续推进；M2 接入前落实模型、凭据和预算，不读取其他项目私有凭据 |
| 性能阈值 | 题目阈值尚未实测校准 | 不复制原项目的固定毫秒数；按评分标准记录同机对照 |
| 原仓库基线 | 固定版本已记录，完整原测试未运行 | 集成题阶段在独立副本验证；本项目检查通过不代表七个仓库通过 |
| 受限沙盒下的 tsx/vitest | 受限权限下 esbuild、vite、vitest 以管道创建子进程被拒（spawn EPERM），`pnpm catalog:check`、`pnpm test`、`pnpm build` 无法运行；完整权限（本次为 danger-full-access）下已全部通过 | 受限时改跑 `node scripts/catalog.ts --check` 与 `node scripts/task.ts verify`（题目包工具已改用 node），并如实记录哪些检查没跑；不要把未运行的测试记为通过 |

环境不可用时，报告实际错误及受影响的验收项，继续完成独立工作。不能将候选代码直接放到宿主执行后称为 Linux 隔离成绩。

## 6. 验收与下一次交接

每个执行项交付时至少留下：对应任务 ID、修改文件、已完成行为、真实命令及退出结果、未完成项、环境限制、下一步动作和 Agent Note 路径。

修改评分、协议或目录运行相关回归；M1 阶段交付运行 `pnpm check`，涉及界面与 API 集成运行 `pnpm test:e2e`。新执行器还必须有前述故障路径的真实集成证据，不能仅靠 mock 单测验收。

M1 完成需同时满足：8 题具备真实资产、首道到全部试点的提交/冻结/验证路径可运行、错误分类和回收有效、报告均可追溯到冻结候选、性能与线程证据没有被模拟替代。完整代码评审仍留在 M2，待定总分如实保留。

记录规则使用 [Agent Notes](notes/README.md) 的六类分类，不新增全局 INDEX。涉及阶段状态变更时同步更新本文的交接状态与 [roadmap](roadmap.md)；具体规格继续在对应文档维护。

下次交接至少填写以下内容：

```markdown
交接日期：2026-09-14
当前执行项：M1-06 已完成（容器执行未完成）；下一项 M2 核心题库与独立评审
已完成及证据路径：M1-01 见 tasks/core/CACHE-02/、graders/CACHE-02/、packages/tasks、scripts/task.ts；M1-02 见 packages/runs 与提交/冻结协议；M1-03 见 packages/executor 与 ExecutionResult 协议；M1-04 见 apps/cli、apps/api 的 run 入口与 RunStatus 协议；M1-05/06 见 tasks/core/ 下 8 个题目包、graders/ 与 docs/trials/2026-09-14-m1-pilot.md。落盘证据在 data/task-runs/、data/runs/、data/trials/（均已忽略）。
未完成及原因：M1-02 至 M1-06 未开始；Linux 容器、提交冻结、完成事件、代码质量评审仍缺失。
实际检查命令与结果：pnpm check exit 0（53 项 vitest、生产构建通过）；pnpm test:e2e exit 0（1 项）；8 道题各自 node scripts/task.ts verify <ID> 六阶段通过；node scripts/trial.ts 8/8 通过；pnpm bench submit 自动验证与同键复用通过。
运行中的本任务服务/端口（没有则写无）：无
工作区/提交状态：已创建首次提交 `bc3a613`（138 个文件），工作区干净；此前 M0 初始化文件一直未跟踪，现已全部纳入版本控制。
新增依赖与环境要求：无第三方运行时依赖；新增 workspace 包 @fsa/tasks、@fsa/runs、@fsa/executor，需重新 pnpm install；题目包、控制面与执行器要求 Node >=24.14.1（原生类型剥离）与 git（应用参考补丁）。容器内执行还需要可用的 Linux 容器运行时，本机没有。
下一位从哪个文件、哪个动作开始：先读 docs/notes/implemented/feature/2026-09-14-container-profile-and-pinned-image.md 的 runbook，在有容器运行时的机器上预载固定 digest 的镜像，再跑 `pnpm bench submit --profile linux-container …` 与 `BENCH_PROFILE=linux-container pnpm trial`；容器跑通后按 docs/roadmap.md 的 M2 推进核心题库与独立评审。
对应 Agent Note：cache-02-task-package（M1-01）、submission-freeze-control-plane（M1-02）、minimal-executor-and-fault-classification + container-profile-and-pinned-image（M1-03）、submit-entry-and-run-status（M1-04）、m1-pilot-pack-and-trial（M1-05/06），均在 docs/notes/implemented/feature/ 下。
```

## 7. 可直接交给下一位 AI 的执行指令

```text
请接手 C:\Users\A\Documents\ChatGPT\Forever_Skywalker_AI_Benchmark。
先读 AGENTS.md 和 docs/handoff.md，再按链接核对已确认需求、架构与评分标准。
当前 M1 已基本完成：55 道题是设计目录，其中 8 道试点有真实题目包与受信资产，
提交、冻结、执行与查询链路在宿主 profile=local 下可用，容器隔离、质量评审与正式成绩都还没有，
预览分数不是正式成绩。

M1 已交付：8 道试点都有真实题目包，提交/冻结/执行/查询链路可用，试跑 8/8 通过，
容器档案的代码也已实现——唯一剩下的是在真实容器里跑一次。
若你有容器运行时：按容器档案 Agent Note 的 runbook 预载固定 digest 的镜像，
再跑 `pnpm bench submit --profile linux-container …` 与 `BENCH_PROFILE=linux-container pnpm trial`。
若没有：按 roadmap 从 M2 开始（核心题库、隐藏数据按题族划分、独立裁判与人工复核）。
8 道题的公开接口、检查 ID、导出白名单、提交/冻结协议与执行结论口径均已冻结，
修改它们必须同时提升题目版本并说明原因。
保持 50/50 评分、四级规则、现有预览接口和来源仓库只读边界。
常规实现自行推进，不重新进行已经完成的需求确认，不扩大到完整 55 题。
代码评审缺失时总分保持待定，不使用假设质量分补齐。

先核对当前工作区和工具环境，保留未跟踪的初始化文件与用户修改。
如果容器等环境受限，完成不依赖它的工作并记录具体未通过验收项。
每个非平凡变更附中文 Agent Note，运行必要检查，以真实产物和证据更新
docs/handoff.md 及 docs/roadmap.md，最后交代已完成、未完成和下一步入口。
```
