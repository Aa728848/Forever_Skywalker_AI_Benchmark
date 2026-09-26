# Agent Note: 网页操作入口：配置面板与受控发起测评

Status: implemented

## Problem

网页此前是只读查询面板（题目目录、评分预览、运行记录）：改 `.env`、发起 `pnpm dsh:compare` 都只能在 CLI 做。本轮把网页做成完整操作入口，有两个必须正面回答的约束。

- **配置写入**：`.env` 里既有普通字段也有令牌。网页必须能在不回显任何密钥值、不把密钥写进响应正文的前提下写入配置，并且保存后当前进程立即按新值工作——若要求重启 API，操作者会失去正在查看的报告与运行记录。
- **发起测评**：实验子进程要跑几十分钟并消耗真实模型额度。API 直接 `spawn` 它被否决：API 在 spawn 之后、PID 落盘之前崩溃，子进程就成了无主进程继续消耗额度；API 不是这些后代的父进程，收不到 exit 事件，重启后无法区分「正常跑完」和「被杀了」；父进程先退出后 `taskkill /T` 也找不到整棵树。

## Decision

### 1. 配置抽成 @fsa/config 包，网页只写白名单键

- `packages/config`（`@fsa/config`）承载项目 `.env` 读写：`readProjectEnvironment` / `saveProjectEnvironment` / `EnvironmentFileConflictError` / `ProjectEnvironmentSnapshot` 从 `apps/cli/src/env-file.ts` 迁入（`apps/cli/src/env-file.ts` 与其测试已删除），并新增 `missingGroups` / `validateConfigPatch` / `maskedConfigView` / `secretValues` / `redactStream` / `secretKeyPattern`。`apps/cli` 与 `apps/api` 从同一处取这套语义。
- `secretKeyPattern = /(_TOKEN|_SECRET|_KEY|_PASSWORD)$/i` 只看键名判定密钥；命中者只暴露 `configured`，是否隐藏不取决于值。
- `apps/api/src/config.ts` 的 `createConfigProvider` 提供 `current()` / `snapshot()` / `view()` / `validate()` / `plan()` / `save()` / `models()`。`save()` 成功后立即重算 `current()`，`apps/api/src/runs.ts` 的 `enabled()` / `disabledReason()` / `profile()` / `token()` 因此由启动时固定的属性改为按操作求值的函数：`/api/health`、提交入口、令牌比较与发起测评都在保存后立刻按新值工作，**无需重启 API**。
- 网页可写键是白名单：作答侧 `BENCH_DSH_PROVIDER/MODEL/PRESETS/REASONING_EFFORT/WORKSPACE_PERMISSION`；裁判侧 `BENCH_JUDGE_DSH_PROVIDER/MODEL/REASONING_EFFORT/MAX_TOKENS/TIMEOUT_MS` 与 `BENCH_JUDGE_PROMPT_VERSION`；目录与预算 `BENCH_DSH_REPORT_DIR`、`BENCH_SUBMISSIONS_DIR`、`BENCH_MEASURE_PERFORMANCE`；以及命中密钥键名的键（例如 `BENCH_JUDGE_TOKEN` 轮换）。
- 只读项在视图里带 `writable: false` 与原因，写入路径也真的拒绝，所以「不可网页编排」是约束而不是提示：`BENCH_RUN_DIR`（既有 run 记录的物理位置）、`BENCH_DSH_ROOT` / `BENCH_DSH_HOME` / `BENCH_DSH_PROFILE`（进程级执行链路）、`BENCH_IMAGE` / `BENCH_IMAGE_DIGEST`（执行环境身份）、`BENCH_PROFILE`（决定既有记录口径）。
- 写入分两段：`POST /api/config` 不带 `confirm: true` 时只返回待写清单——普通字段给出值，密钥字段只给 `{ field, text: '已填写' }`；带 `confirm: true` 才落盘。清空既有非空值被明确拒绝（400），不是静默跳过；并发冲突映射为 409，不重试也不覆盖。
- 前端 `apps/web/src/ConfigPanel.tsx` 按「作答 / 裁判 / 目录与预算」三组渲染字段，另列「只读项」区；被非空 OS 环境变量遮蔽的键标「被系统环境变量覆盖」，确认弹窗再次提示保存后仍以环境变量为准。

### 2. 受控发起测评：API 不持有实验子进程

链路固定为 `API --spawn(detached)--> scripts/experiment-supervisor.ts --spawn--> scripts/dsh-compare.ts`。

- **自登记握手**：supervisor 启动后第一件事是把 `{ pid, pidStartedAt, supervisorToken, state: 'registered', heartbeatAt }` 原子写入启动记录，然后才 spawn 子进程。
- **执行前授权屏障**：supervisor 重读启动记录复核令牌与租约相符；令牌经 `BENCH_SUPERVISOR_TOKEN` 与 `BENCH_LAUNCH_RECORD` 传给子进程，`scripts/dsh-compare.ts` 的 `authorizeControlledLaunch` 在参数解析之后、任何作答之前再校验一次（令牌一致、记录状态为 `running`/`registered`、心跳未过租约）。
- **心跳与租约**：每 5 秒原子更新 `heartbeatAt`，租约 TTL 30 秒。
- **持有进程树**：POSIX 用 `detached: true` 建独立进程组并整组终止；Windows 下 supervisor 全程存活，`taskkill /pid <childPid> /t` 始终能找到整棵树。
- **退出事实**：子进程退出时 supervisor 原子写 `exit.json`（`code` / `signal` / `at` / `descendantsVerified` / `note` / `cancelled`），然后自己退出。
- **代理取消**：API 只写取消标记文件；supervisor 轮询该标记，按优雅→强制升级终止并确认退出。
- **子进程认领报告目录**：`scripts/dsh-compare.ts` 新增可选 `--experiment-id`（`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`），用 `mkdirSync(directory, { recursive: false })` 原子认领 `<报告根>/<id>`，已存在即拒绝，绝不覆盖已有实验。**未给出 `--experiment-id` 与 `--supervisor-token` 时行为与改动前完全一致**，手工 `pnpm dsh:compare` 不受影响。

### 3. 状态归并：四个事实不互相冒充

`apps/api/src/launches.ts` 的 `mergeState(experimentState, recordState, exitFact, cleanupState)` 是唯一决定展示语义的纯函数，四个输入各自独立：`experiment.json` 的 `state`（工作子进程写）、启动记录的进程判定（API 读事实后落定）、`exit.json`（supervisor 写）、`experiment.json` 的 `cleanup`（工作子进程写）。

- 有 `exit.json`：退出码 0 且（`experiment.json` 为 `completed` 或不存在，即仅预检）→ 已完成；否则若判定为取消（显式取消事实、取消类信号，或 `experiment.json` 记录 `cancelled`）→ 已取消，不是失败；其余 → 失败。
- 无 `exit.json`：跟随启动记录的进程判定；租约过期且归属不可证时落定 `unknown`（「执行状态未知，可能仍在运行」），绝不推断成启动失败。
- 清理只认 `experiment.json` 的明写值 `complete` / `retained`，`pending` 或不登记一律「清理未知，可能残留」。子进程被强杀时写者已死，不会自己写 `retained`，因此只能如实说未知。
- `aborted`（进程判定）与 `cleanup`（清理判定）永不合并。

### 4. 对账与纯读

- `launches.sweep()` 由 API 启动时先跑一次，之后每 10 秒一次（`setInterval` + `unref`）：读 `exit.json` 落定 `exited`/`cancelled`，租约过期时落定 `unknown`，取消标记加进程判定消失落定 `aborted`。单条记录对账失败不影响其它记录。
- `GET /api/experiments` 只调用 `list()` / `describe()`，不写任何文件、不触发对账；测试断言 GET 前后启动记录字节不变。

### 5. 路由、令牌与页面

- 只读、不需令牌：`GET /api/reports`、`GET /api/reports/:reportId`、`GET /api/reports/:reportId/artifacts/:artifactId`、`GET /api/config`、`GET /api/config/models`、`GET /api/experiments`、`GET /api/submissions`。
- 需要 `x-bench-token`：`POST /api/config`、`POST /api/experiments`、`POST /api/experiments/:launchId/cancel`、`POST /api/submissions`。令牌按操作从配置读取，并用定时安全比较。
- 前端 `apps/web/src/LaunchPanel.tsx` 把「发起自动测评 / 实时看进度 / 取消」与「提交外部作答」放进同一页签：默认按钮是「仅预检」（`check: true`，不调用模型），「发起真实作答…」先弹出二次确认并显示计划总作答次数，确认后才提交；页面只显示服务端 `merged` 结论与残留三态，不自行推断；启动记录中存在 `merged.process === 'live'` 时才每 3 秒轮询。提交候选来自 `BENCH_SUBMISSIONS_DIR` 下一层，提交复用既有冻结与可用验证链路，不另写一套。

## Alternatives considered

- **API 直接 spawn `dsh-compare`**：API 崩溃在 spawn 与 PID 落盘之间会留下无主子进程继续消耗模型额度，且 API 收不到 exit、重启后无法区分正常完成与被杀。改由 detached supervisor 持有进程树并落盘退出事实。
- **supervisor 只做心跳、不做授权屏障**：子进程无法证明自己属于一次受控启动，手工写入的启动记录就能让进程跑起来。改为令牌加租约双重校验，不符即拒绝执行。
- **只按 pid 判断进程归属**：pid 会被回收，Windows 上尤其容易把无关进程当成自己启动的。改为同时校验 `pidStartedAt`，取不到启动时间就如实降级为 `unconfirmed`。
- **没有 `exit.json` 就报失败或已完成**：那是把「不知道」伪装成结论。改为如实返回 `unknown`，交由租约与退出事实分别说话。
- **清理状态由 API 推断**：API 不持有子进程，无法知道临时目录是否还在。改为只认 `experiment.json` 的明写值。
- **配置保存要求重启 API**：会让操作者在保存后失去当前页面与内存中的运行视图。改为 `ConfigProvider.current()` 按操作取值。
- **允许网页改 `BENCH_RUN_DIR`**：它决定既有 run 记录的物理位置，改完历史记录会看起来消失。改为只读并给出原因。
- **一次请求直接落盘（没有 plan/confirm 两段）**：密钥值就会进入响应正文。改为两段式，密钥只回「已填写」。
- **网页整文件重写 `.env`**：会丢掉注释、未知键与 CRLF。沿用 `saveProjectEnvironment` 的「只改被列出键」覆写语义。

## Consequences

- 网页现在能在同一界面改配置、发起测评、看进度、读报告、下载产物，且不需要重启 API。
- 边界：网页仍是单机单写者的操作入口。它发起的是「操作者点一次、supervisor 托管一个实验」的受控运行，**不是**排程、公开托管、多租户或无人值守的自动编排——`docs/requirements.md` 的排除项本身仍然有效，未删除。该文件只有两处措辞就地更新以匹配交付事实：第 5 条由「Web 面板用于查看题目、运行记录与报告」补上「修改配置与发起单次自动测评（仍需操作者确认、由受控 supervisor 托管）」，排除项由「全自动模型作答编排」明确为「无人值守的模型作答自动编排」。
- 已知限制（如实记录，不美化）：
  1. Windows 上取进程启动时间依赖 PowerShell `Get-CimInstance Win32_Process`，负载高时可能超时；此时归属降级为 `unconfirmed`（不假装确认）。取消路径另有「心跳仍在租约内」作为独立存活证据。
  2. Windows 上几乎不会出现「已确认无残留」：`taskkill /t` 之后无法排除已脱离进程组的后代，因此刻意保守报 `unknown`。
  3. 既有产品缺口：`@fsa/config` 的 `validateConfigPatch` 在补丁涉及 `BENCH_JUDGE_*` 时，若 `BENCH_DSH_ROOT` / `BENCH_DSH_HOME` 未配置，会退回 HTTP 裁判校验 `judgeConfigFromEnvironment`，而它不认 `BENCH_JUDGE_DSH_*` 键，于是返回 400「未知配置项」。即**未先配好裁判链路时，网页改不了裁判字段**；真实部署先跑 `pnpm start` 会写入 DSH 目录，正常路径不受影响。该事实由 `apps/api/src/config.test.ts` 的「已知约束」用例固定。
  4. 真实模型端的端到端取消未验证（需要真实额度）；测试全程使用假脚本，唯一跑真实 `dsh-compare.ts` 的接线测试只到 `--check`。

## Verification

- `pnpm check`：332 项测试通过（27 个测试文件）、`tsc --noEmit` 通过、目录一致、生产构建成功。
- `pnpm test:e2e`：7 项通过，其中 `tests/e2e/config-panel.spec.ts` 3 项、`tests/e2e/report-center.spec.ts` 2 项。
- 新增测试文件：`packages/config/src/env-file.test.ts`（12）、`packages/config/src/config.test.ts`（6）、`apps/api/src/reports.test.ts`（9）、`apps/api/src/config.test.ts`（14）、`apps/api/src/launches.test.ts`（27）、`tests/e2e/report-center.spec.ts`（2）、`tests/e2e/config-panel.spec.ts`（3）。
- `packages/config/src/env-file.test.ts` 覆盖 `.env` 读取与安全写入的既有语义：缺文件只读不落盘、非空 OS 变量优先、只改真实空赋值、显式 `replace` 才覆写非空值、无法安全定位赋值时整批拒绝、dotenv 无损往返、非法变量名不泄漏值、并发保存锁，以及 `partial-write`/`rename` 两种失败路径保持旧文件完整并回收临时文件与锁。
- 配置面板实测：仓库根 `.env` 全程未被创建；`GET /api/config` 响应不含任何密钥值；无令牌 `POST /api/config` 返回 401；令牌轮换后旧令牌立即失效、新令牌立即可用。
- `apps/api/src/launches.test.ts` 覆盖：`mergeState` 真值表（含「无 `exit.json` 且租约过期 → `unknown`」「`cleanup` 仍 pending → 清理未知」「`aborted` 与 `cleanup` 不合并」）、三阶段握手、四类故障窗口（spawn 前 supervisor 退出、API 重启后落定 `exited`、父先退出而孙进程存活、GET 纯读字节不变）、supervisor 代理取消、`--experiment-id` 非法或已存在即拒绝、授权屏障，以及与真实 `scripts/dsh-compare.ts` 的 `--check` 接线。
- `tests/e2e/config-panel.spec.ts` 覆盖：未带令牌的写请求真的收到 401 且磁盘不变、输入令牌后先看清单再写入并刷新后仍生效、密钥字段不出现值、只读字段被标注且服务端真的拒绝写入。
- `tests/e2e/report-center.spec.ts` 覆盖见 [报告中心 Note](2026-09-26-experiment-report-api.md)。
