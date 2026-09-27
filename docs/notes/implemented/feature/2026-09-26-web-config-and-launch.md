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

### 3. 状态归并：实验自身的结论与退出码不互相冒充

`apps/api/src/launches.ts` 的 `mergeState(experimentState, recordState, exitFact, cleanupState, reportFacts = null)` 是唯一决定展示语义的纯函数，五个输入各自独立：`experiment.json` 的 `state`（工作子进程写）、启动记录的进程判定（API 读事实后落定）、`exit.json`（supervisor 写）、`experiment.json` 的 `cleanup`（工作子进程写），以及 `experiment.json` 的逐行验证统计 `reportFacts: { rows, passed, unpassed } | null`（由 `readExperimentFacts` 数 `rows[].evaluation.status.classification === 'passed'` 得出，`rows` 不是数组时整块为 null）。

`MergedState` 增加 `reportOutcome: 'running' | 'completed' | 'completed-with-failures' | 'cancelled' | 'failed' | null`：实验自身的结论，没有 `experiment.json` 或 `state` 不可识别时为 null。它与 `verdict` 是两件事——`verdict` 说整个启动记录的展示结论，`reportOutcome` 只复述归档。

- **退出码是 CI 语义，不是实验结论**：`scripts/dsh-compare.ts` 在「实验没跑完，或任一行未通过」时置 `process.exitCode = 1`。模型答错题也会得到退出码 1，因此退出码不能单独决定「失败」。
- 真值表（有 `exit.json`）：
  - `experiment.json` 为 `completed` 且有行未通过（`reportFacts.unpassed > 0`；读不到统计时以非零退出码兜底）→ `verdict = 'completed-with-failures'`，文案「已完成但有未通过行：… N 行未通过（共 M 行）」。
  - `experiment.json` 为 `completed` 且逐行全部通过 → 已完成；退出码与归档不一致时并置说明「与归档不一致，请核查该退出码的来源」，不静默丢弃异常退出码。
  - `experiment.json` 为 `failed` → 失败；判定为取消（显式取消事实、取消类信号，或 `experiment.json` 记录 `cancelled`）→ 已取消，取消优先于 `completed-with-failures`。
  - 只有 `exit.json`、没有 `experiment.json`（例如 `--check` 预检）→ 维持原有语义：退出码 0 → 已完成，非零 → 失败；`reportOutcome` 为 null。
- 无 `exit.json`：跟随启动记录的进程判定；租约过期且归属不可证时落定 `unknown`（「执行状态未知，可能仍在运行」），绝不推断成启动失败。此时 `reportOutcome` 仍如实带出归档自己的结论，但 `verdict` 不因此被拔高成 `completed`。
- 清理只认 `experiment.json` 的明写值 `complete` / `retained`，`pending` 或不登记一律「清理未知，可能残留」。子进程被强杀时写者已死，不会自己写 `retained`，因此只能如实说未知。
- `aborted`（进程判定）与 `cleanup`（清理判定）永不合并。
- 残留三态由 `scanResidue()` 给出，次序即优先级：**运行中**（进程判定为 `starting`/`registered`/`running` 且 supervisor 可证存活）只给中性描述「运行中，子进程树 N 个存活进程（pid…）」——子进程树在场是这次实验正在做的工作，不是残留；**终止之后仍能证明归属的存活进程**（记录里的后代与直接子进程按 pid 加 `pidStartedAt` 逐个核对）才报 `present`；**已落定**（`exited`/`cancelled`/`aborted`）且 `exit.json` 的 `descendantsVerified=true` 报 `none`，依据是 supervisor 在写退出事实前的终止后核对；其余（没有 `exit.json`、核对为 `false`、或存在拿不到启动时间的存活 pid）一律 `unknown`。API 不做跨进程猜测（不扫全盘同名进程），宁可 `unknown`，也不把「不知道」写成「干净」。

### 4. 对账与纯读

- `launches.sweep()` 由 API 启动时先跑一次，之后每 10 秒一次（`setInterval` + `unref`）：读 `exit.json` 落定 `exited`/`cancelled`，租约过期时落定 `unknown`，取消标记加进程判定消失落定 `aborted`。单条记录对账失败不影响其它记录。
- `GET /api/experiments` 只调用 `list()` / `describe()`，不写任何文件、不触发对账；测试断言 GET 前后启动记录字节不变。
- `launches.clean(launchId)`（`DELETE /api/experiments/:launchId`，需令牌）把账本 json、`exit.json`、日志与取消标记移进 `<启动根>/.trash`，一个字节都不删，可手动移回。闸门只拦「真的还在跑」，两条独立证据命中任一即 409：进程判定仍为 `starting`/`registered`/`running`，或残留扫描报 `present`（存在能证明归属的存活进程）。`exited`/`cancelled`/`aborted`/`unknown` 一律允许归档。
- `unknown` 允许归档的理由：`reconcile()` 只在「supervisor 租约已过期且检不出可证明归属的存活进程」时才落定 `unknown`，此时账本不再是 sweeper 的对账依据；操作者显式归档即接受「若有已脱离进程组的后代，将失去它的账本」。`record.state` 缺失或无法识别时仍拒绝归档。

### 5. 路由、令牌与页面

- 只读、不需令牌：`GET /api/reports`、`GET /api/reports/:reportId`、`GET /api/reports/:reportId/artifacts/:artifactId`、`GET /api/config`、`GET /api/config/models`、`GET /api/experiments`、`GET /api/submissions`。
- 需要 `x-bench-token`：`POST /api/config`、`POST /api/experiments`、`POST /api/experiments/:launchId/cancel`、`DELETE /api/experiments/:launchId`、`POST /api/submissions`。令牌按操作从配置读取，并用定时安全比较。
- **无请求体的请求不因 content-type 被拒**：`buildApp` 在 `preParsing` 钩子里，对「没有 `content-length`（或为 0）且没有 `transfer-encoding`」的请求摘掉 `content-type`，让 Fastify 走「无 content-type」的既有路径。没有这一层时，取消请求带 `application/json` 且无请求体时会被默认解析器以 400 `FST_ERR_CTP_EMPTY_JSON_BODY` 拒绝，请求到不了 `launches.cancel()`（网页「取消这次测评」曾经点了没反应）。判定只看传输层事实，不动业务字段：确实带了请求体的请求（含畸形 JSON）行为完全不变，无令牌仍先返回 401。
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
  2. 「已确认无残留」不按平台分叉：唯一判据是 `exit.json` 的 `descendantsVerified`，即 supervisor 在写退出事实前对整棵后代进程树的核对结论。Windows 上 `taskkill /t` 之后仍可能有已脱离进程组的后代，因此该核对为 `false` 或缺失时照旧如实报 `unknown`。
  3. 既有产品缺口：`@fsa/config` 的 `validateConfigPatch` 在补丁涉及 `BENCH_JUDGE_*` 时，若 `BENCH_DSH_ROOT` / `BENCH_DSH_HOME` 未配置，会退回 HTTP 裁判校验 `judgeConfigFromEnvironment`，而它不认 `BENCH_JUDGE_DSH_*` 键，于是返回 400「未知配置项」。即**未先配好裁判链路时，网页改不了裁判字段**；真实部署先跑 `pnpm start` 会写入 DSH 目录，正常路径不受影响。该事实由 `apps/api/src/config.test.ts` 的「已知约束」用例固定。
  4. 真实模型端的端到端取消未验证（需要真实额度）；测试全程使用假脚本，唯一跑真实 `dsh-compare.ts` 的接线测试只到 `--check`。
  5. `completed-with-failures` 只说明「有几行没通过可用验证」，不说明分数高低，也不构成正式成绩；行数只从 `experiment.json` 的 `rows` 数出，不引入任何需要额外跑分才能得到的信息。逐行统计读不到时用「`completed` + 非零退出码」兜底识别有未通过行——这是 `dsh-compare.ts` 的 CI 退出语义，不是归档的明写事实，因此兜底路径的文案只说「有未通过行」而不报具体行数。

## Verification

- `pnpm check`：332 项测试通过（27 个测试文件）、`tsc --noEmit` 通过、目录一致、生产构建成功。
- `pnpm test:e2e`：7 项通过，其中 `tests/e2e/config-panel.spec.ts` 3 项、`tests/e2e/report-center.spec.ts` 2 项。
- 新增测试文件：`packages/config/src/env-file.test.ts`（12）、`packages/config/src/config.test.ts`（6）、`apps/api/src/reports.test.ts`（9）、`apps/api/src/config.test.ts`（14）、`apps/api/src/launches.test.ts`（27）、`tests/e2e/report-center.spec.ts`（2）、`tests/e2e/config-panel.spec.ts`（3）。
- `packages/config/src/env-file.test.ts` 覆盖 `.env` 读取与安全写入的既有语义：缺文件只读不落盘、非空 OS 变量优先、只改真实空赋值、显式 `replace` 才覆写非空值、无法安全定位赋值时整批拒绝、dotenv 无损往返、非法变量名不泄漏值、并发保存锁，以及 `partial-write`/`rename` 两种失败路径保持旧文件完整并回收临时文件与锁。
- 配置面板实测：仓库根 `.env` 全程未被创建；`GET /api/config` 响应不含任何密钥值；无令牌 `POST /api/config` 返回 401；令牌轮换后旧令牌立即失效、新令牌立即可用。
- 归档闸门由 `apps/api/src/launches.test.ts` 的「归档启动记录（clean）的闸门只拦『真的还在跑』」固定：`unknown` 且无可证明归属的存活进程 → clean 成功且列表不再显示（账本原样躺在回收目录）；`starting`/`registered`/`running` → 409 且账本不动；残留 `present`（真实存活的睡眠子进程，`pidStartedAt` 归属可证）→ 409 且文案指明「可证明归属的存活进程」。**反向验证**：把 `unknown` 移出可归档集合后第一条失败，去掉 `residue.status === 'present'` 闸门后第三条失败，说明两条闸门都是承重的。
- `apps/api/src/launches.test.ts` 覆盖：`mergeState` 真值表（含「无 `exit.json` 且租约过期 → `unknown`」「`cleanup` 仍 pending → 清理未知」「`aborted` 与 `cleanup` 不合并」「`completed` + 有未通过行 + 退出码 1 → `completed-with-failures`，不再判成失败」「`state=failed` 仍为失败」「取消优先于 `completed-with-failures`」「无 `exit.json` 时不拔高 `verdict` 但 `reportOutcome` 如实带出」）、残留口径（运行中不以「仍有残留」告警只给中性描述、`descendantsVerified=true` → `none`、没有退出事实且归属不可证 → `unknown`）、三阶段握手、四类故障窗口（spawn 前 supervisor 退出、API 重启后落定 `exited`、父先退出而孙进程存活、GET 纯读字节不变）、supervisor 代理取消、`--experiment-id` 非法或已存在即拒绝、授权屏障，以及与真实 `scripts/dsh-compare.ts` 的 `--check` 接线。
- `tests/e2e/config-panel.spec.ts` 覆盖：未带令牌的写请求真的收到 401 且磁盘不变、输入令牌后先看清单再写入并刷新后仍生效、密钥字段不出现值、只读字段被标注且服务端真的拒绝写入。
- `apps/api/src/launches.test.ts` 的「取消路由容忍『带 JSON content-type 却无请求体』」固定住这条回归：无令牌仍 401、带 JSON 头且空体返回 200 且取消标记与 `cancelRequestedAt` 都已落盘、带畸形 JSON 照旧 400 `FST_ERR_CTP_INVALID_JSON_BODY`。**反向验证**：去掉 `preParsing` 钩子后该用例失败（授权前就被 400 挡回），说明容忍层是承重的。
- `tests/e2e/launch-cancel.spec.ts` 覆盖真实的取消链路：启动记录由用例写入 playwright 注入的临时启动记录根（`BENCH_E2E_LAUNCHES_ROOT`，仓库根 `data/launches` 不受影响），supervisor 是真实的 `scripts/experiment-supervisor.ts`，被监督的是长睡不醒的假子进程；页面点「取消这次测评」后请求不带 `content-type`、显示「取消结论 delegated」、徽标变「已取消」，API 侧 `state=cancelled` 且取消标记与退出事实均已落盘。**反向验证**：把客户端改回带 `headers` 的旧写法后该用例失败（请求带上了 `application/json`）。
- `tests/e2e/report-center.spec.ts` 覆盖见 [报告中心 Note](2026-09-26-experiment-report-api.md)。
