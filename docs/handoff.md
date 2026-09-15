# 开发交接与执行手册

## 最新交付：DSH 评分 Agent 已接入质量链

`createQualityProvider()` 现在默认使用 `createDshJudgeFromEnvironment`，不再自动路由到 HTTP 裁判。评分 Agent 每轮创建独立 DSH session，采用 review-only 无工具预设，严格校验 JSON、题目/运行身份、版本和证据引用；两轮需保持 DSH 版本、预设指纹和模型路由一致。评分模型通过 `BENCH_JUDGE_DSH_PROVIDER`、`BENCH_JUDGE_DSH_MODEL`、`BENCH_JUDGE_DSH_REASONING_EFFORT`、`BENCH_JUDGE_DSH_MAX_TOKENS`、`BENCH_JUDGE_DSH_TIMEOUT_MS` 配置。`BENCH_DSH_ROOT/HOME/PROFILE/WORKSPACE_PERMISSION` 沿用作答 DSH 配置，未知用量记为 null。评分超时、无效响应或回收失败继续保持质量分待定，不生成假分数。

本轮离线验证：`dsh-judge.test.ts` 与 `evaluation.test.ts` 共 6 项通过；未调用真实模型。评分模型可以与作答模型相同，但仍是不同 session。真实 DSH 供应商认证和正式评分校准仍需用户另行运行，不能把离线结果当作模型成绩。

更新：2026-09-14。本文件描述当前状态；历史 M0/M1 Note 保留当时事实，不用于推断当前完成度。

## 最新交付：DSH 工作区权限与报告路径

DSH 自动比较新增 `BENCH_DSH_WORKSPACE_PERMISSION` / `--workspace-permission`，支持 `read-only`、`workspace-write`（默认，建议代码题使用）和 `danger-full-access`。运行时通过 DSH 公开的 `DSH_PERMISSION_MODE` 环境变量传给 SDK；每题独立工作区作为边界，权限写入 `experiment.json` 并显示在 `report.md`。快速启动和首次 `.env` 配置均可选择，完整访问会显示警告。报告默认位于 `data/experiments/<时间戳>-<随机ID>/`，结束时打印 `report.md`、`experiment.json`、`evidence.json.gz` 的绝对路径；`BENCH_DSH_REPORT_DIR` 或 `--output` 可更改父目录。相关记录见 [DSH 权限 Note](notes/implemented/feature/2026-09-15-dsh-workspace-permission.md) 与 [报告位置 Note](notes/implemented/feature/2026-09-14-report-location-output.md)。本轮未调用真实模型/裁判。

用户已授权继续完成项目和安装 Linux 依赖。工作目录：`C:/Users/A/Documents/ChatGPT/Forever_Skywalker_AI_Benchmark`。七个来源仓库只读；接手先检查 git status，保留当前改动，不重新初始化。

用户已自行重启Windows，固定Linux容器已配置并验收。实际模型评测仍暂停；不会因环境就绪自动调用真实裁判。

## 最新交付：快速配置 .env

`pnpm start`/`start.cmd` 在缺少 `.env` 或关键字段时先进入环境配置：生成本地 API 访问令牌，选择提交/运行目录和 Linux 或本机档案，复用已记录的固定镜像，补齐 DSH 项目/home/报告路径，并用本地校验器收集裁判供应商、端点、模型、隐藏令牌、思考参数和预算。已有非空环境变量、`.env` 注释/未知键和 DSH 原配置保留；OS 非空同名变量优先。令牌不进入普通提示、命令参数或报告，确认前不写文件，取消/放弃保存不会落盘；保存后新环境只传给本次及其子进程，不隐式改写当前 `process.env`。

裁判表单支持8家原生供应商及 OpenAI-compatible，参数检查复用 `judgeConfigFromEnvironment`/`createEnvironmentJudge`，没有网络请求或真实模型调用。DSH 本地目录读取仍只返回 provider/model/已声明思考等级；没有目录或额外 profile 时保留手工输入。快速配置实现、保存并发保护、密钥终端行为见 [环境配置 Note](notes/implemented/feature/2026-09-14-env-setup.md)、[裁判表单 Note](notes/implemented/feature/2026-09-14-judge-setup.md) 和 [终端 Note](notes/implemented/feature/2026-09-14-terminal-secret-input.md)。

本轮最终 `pnpm check` 通过247项测试、严格类型、55题目录与生产构建；配置相关聚焦测试38项。此前快速启动实测仍有效，新增环境配置测试使用系统临时目录和虚构令牌，未读取或修改用户真实 `.env`，未调用模型/裁判。

## 最新交付：终端分步启动

新增 `pnpm start` 和 Windows 根目录 `start.cmd`。向导依次选择供应商/模型、DSH预设、思考等级、题目、预算和报告目录；最后展示组合次数、裁判状态与可复制命令，默认仅预检。还可导出外部作答、提交完成作答、启动网页/API或检查Linux环境。外部作答默认导出到仓库外的 `Documents/BenchAnswers`；不改写.env、原DSH配置或评分规则。

DSH目录读取调用已安装DeepSeek/Pi-ai适配器的本地接口，返回provider/model和声明的思考等级，不调用远程目录或模型。额外插件/profile覆盖有明确手工输入入口。未声明等级默认default；同名模型按供应商隔离。完整操作见 [快速启动](quick-start.md)，实现与限制见 [向导Note](notes/implemented/feature/2026-09-14-interactive-launcher.md) 和 [本地目录Note](notes/implemented/feature/2026-09-14-dsh-local-model-catalog.md)。

本轮 `pnpm check` 215项测试、严格类型、55题目录和构建通过。真实Windows终端选择标准/PTC × off/high，CACHE-02共4次计划，最终仅预检通过；模型调用0。外部导出实跑、项目外调用start.cmd并q退出通过，临时验证目录已清理。未变更题包或网页/API行为，不重复全量题目和浏览器验证；下方202项为上一轮交付。

## 最新交付：55题全量工程质量复核

逐题审查55题后改善32题、澄清4题、保留19题。新版任务强化异步生命周期、持久事务/崩溃恢复、多资源并发、插件发布回滚、增量图和有界流式投影；基础题保留作退化门槛。原有及新增83个近似错误修复均有对应版本和补丁哈希的有效检出记录。逐题版本、理由和证据见 [全量审查矩阵](reviews/2026-09-14-full-task-quality-audit.md) 与 [机器矩阵](../catalog/task-quality-audit.json)。

固定Linux分18题及37题两批复验，55/55通过；55个起始缺陷精确检出，参考/替代110次均50/50。PERF-03/04新增专用主路径负载各参考/替代一次，共4/4通过；不是正式配对性能校准。最终 `pnpm check` 202项、严格类型/目录/构建通过，本轮端到端2项通过。原始记录与逐题结果见 [最新Linux验收](trials/2026-09-14-full-quality-linux-validation.md)。下方旧题版本、检查数和历史“待强化”项不覆盖本节最新结论。

新增 [从启动到看报告](quick-start.md)：Docker负责Linux评分；`dsh:compare`自行启动DSH SDK；`pnpm dev`只负责网页/API；不用DSH则export给编程AI后submit。`--all`选全部55题，`--provider`与`--model`联合确定供应商和模型；同名模型不跨供应商匹配。`--reasoning default`省略DSH思考参数，适用于未声明等级的模型，与明确传off不同；原默认off/high保持。独立审查及修复见 [默认思考参数Note](notes/implemented/bug-fix/2026-09-14-dsh-provider-default-reasoning.md)。

全部任务仍fixture-ready，真实模型/裁判调用0；83个错误变体不是83次AI作答，实际模型通过率、难度和评分阈值继续待校准。根变更记录见 [全量工程质量Note](notes/implemented/testing/2026-09-14-full-engineering-task-quality.md)。本轮按用户授权提交并推送公开仓库，保留已有预览标签。

## GitHub 公开预览

用户已授权全部推送并明确选择公开仓库： [Aa728848/Forever_Skywalker_AI_Benchmark](https://github.com/Aa728848/Forever_Skywalker_AI_Benchmark)。首个预览标签为 `v0.1.0-preview.1`，保留 master 与既有历史；[发布说明](releases/v0.1.0-preview.1.md) 明确评分和难度尚待校准。

发布检查补齐被通用 dist/ 忽略的153个固定 YAML 运行时文件。Git导出的干净目录已通过198项检查、2项界面/API端到端及INT-WEB三向验证；.env、依赖安装目录、本机运行产物不发布。审查和验证依据见 [发布 Note](notes/implemented/process/2026-09-14-github-preview-publication.md)。

## 最新交付：DSH 自动模式比较

用户追加要求现已接入：裁判 `.env` 思考等级说明与两轮映射回归；DSH 标准/PTC/极简/创造真实预设（`standard/ptc/minimal/cordis`），与 `--model`、`--reasoning` 独立设置；`--output` / `BENCH_DSH_REPORT_DIR` 指定报告父目录。比较使用独占临时 RunStore，最终只保留 Markdown、experiment.json 和带哈希的压缩证据，报告校验落盘后清理本次工作区、会话/缓存/附件和评分中间数据。历史共享运行目录与原 DSH 配置不删除；回收或写报告失败保留现场并明确标记。

预设通过 SDK 公开 patch 和 Agent preset 作用域接口在首个模型请求之前挂载，实际选择事件必须核对。已使用真实 DSH 对本机假 SSE 服务检查四种预设均完成且工具集不同，没有外部模型请求；最终 `pnpm check` 198项及类型/目录/构建通过，Windows新命令预检通过。详细命令与清理边界见 [DSH 自动对比](dsh-comparison.md)，验收见 [Agent Note](notes/implemented/feature/2026-09-14-dsh-presets-and-report-cleanup.md)。下方185项为上次交付历史。

新增 `pnpm dsh:compare --model <模型ID>`，通过本地同版 DSH TypeScript SDK 自动导出独立工作区、建立新会话、指定思考等级、等待完成、提交 Linux 验证与质量评分，并保存逐次记录与模式对比表。默认 CACHE-02、Off/High 各一次，可选题目/等级/重复数。`--check` 不启动 DSH 或调用模型，见 [使用说明](dsh-comparison.md)。

仅明确 completed 触发评分；失败/超时/取消与未启动项保留，缺测不补分，环境/裁判漂移拒绝均分，核心和集成分开。费用和供应商实际返回版本未取得，保持缺失。DSH SDK profile 不自动复刻 Web profile；运行时关闭不等于所有脱离工具进程已回收。

本轮 `pnpm check` 通过185项测试及类型/目录/构建；DSH真实SDK模块导入与Linux镜像预检通过，只有模拟作答回归，无真实模型请求。DSH供应商认证、实际作答及独立裁判仍需用户启动后验收；不要把此自动化入口写成已跑出真实模型成绩。记录见 [Agent Note](notes/implemented/feature/2026-09-14-dsh-mode-comparison.md)。

## 最新验收：Linux环境已就绪

固定镜像与.env配置已完成，API健康检查为runProfile=linux-container、isolatedExecution=true。网络、非root、只读、CPU/内存/PID、超时/取消/OOM回收5项实际验收通过；PERF-04专用负载18次容器测量通过，模型调用0。

全量55题三种实现首次54/55通过；GRAPH-04发现测试构造超大断言差异导致OOM，已保持完整20,000节点语义做最小修复，针对复跑1/1通过。最终覆盖55/55，参考与替代110次均50/50，55个起始缺陷准确检出。修复与失败记录均保留，见 [Linux验收报告](trials/2026-09-14-linux-container-validation.md)。另修复了执行记录对Docker扩展参数的32项限制，原始题目命令限制保持不变。

当前阻塞已从容器环境移除；剩余是真实模型/裁判试跑以及静态、性能与难度发布校准，用户尚未启动这些操作。下方“172项测试”等属于上一批对应版本验收。

## 最新交付：裁判配置与题目质量

- 裁判支持8供应商和旧兼容入口，按实际模型校验思考/采样/输出参数，保存固定参数指纹与usage；`pnpm bench judge-config`仅做本地配置检查，不调用模型。说明及官方来源见 [供应商参数](judge-providers.md)。
- 两轮参数或服务返回模型不一致会转待复核；不同裁判参数/版本的作答不能混入同一汇总。
- API-04/GRAPH-04升级0.2.0，分别新增真实SQLite跨进程任务协议，以及批次依赖图与诊断发布一致性。两题共6种近似错误修复全部由预声明目标检出，工具为 `pnpm task:mutants <ID>`。
- 题库审查发现部分原高难题实际偏局部，不能把三向通过当作难度证明；仍有待强化题列在 [质量审查](task-quality-review.md)。规模保持48核心+7集成，全部仍为fixture-ready。
- 最新 `pnpm check` 通过172项测试及类型/目录/构建，`pnpm test:e2e` 2项通过；两题受控回归参考均50/50。详见 [本轮验收](trials/2026-09-14-judge-and-task-quality.md)。下方131项及55题报告属于前一批对应版本的历史验收。

## 当前状态

| 范围 | 已交付 | 剩余验收 |
| --- | --- | --- |
| 核心题库 | 48 道完整题包；五组证据、Windows与固定Linux三种实现验收通过 | 难度与规则校准 |
| 来源集成 | 7/7 固定提交模块集成；来源许可/哈希、Windows与Linux三种实现验收通过 | 发布校准 |
| 完成/执行 | CLI/API 完成、冻结、执行、评分、回收与修订；Linux真实边界5项通过 | 真实模型作答与独立裁判验收 |
| 质量评分 | TS/Python/F# 静态事实；真实性能配对；两轮独立 DSH 评分 Agent、预算、证据、人工复核 | 用户配置 BENCH_JUDGE_DSH_*；真实评分 Agent 和静态/性能阈值校准 |
| 中文面板 | 目录、run/attempt 检查与时间线、证据下载、四级汇总、集成题单列 | 随改动运行端到端测试 |
| Linux | Engine29.7.2/Linux、固定镜像四运行时、5项边界、55题三种实现及性能链均通过 | 固定环境上的发布校准 |

fixture-ready 不等于 ready。缺客观或评审证据时总分保持 null；本机为 local，未满足发布门槛的容器结果为 rehearsal；脚本演练不是模型成绩。

## 本轮修复

- 幂等提交、活跃执行、重启恢复与冻结摘要统一；查询最新完成修订，下载证据验证路径和哈希。
- Node 采用独立测试进程、恢复受信公开检查；重复 ID、异常退出、超时/OOM 和输出超限不能用 PASS 日志绕过。
- 本机历史不再显示为正式成绩；API realpath 校验阻止 junction 越过提交根目录。
- 静态分析读取冻结源码；两轮评审材料一致；性能保留两次预热及七轮配对，不挑最佳样本。
- API-02/03、CONC-02、LIFE-04、STATE-04、THR-01/03、PERF-02/04 补足幂等、字节流、会话、真实线程/进程、DOM 和测量行为。
- 新题及 API-04/GRAPH-04 曾缺功能分组，已补真实检查；manifest 和 trial 增加完整 50/50 门禁。
- 生成器拒绝覆盖既有包；失败仅回滚本次新目录。

## 验收与继续执行

```powershell
Set-Location -LiteralPath 'C:\Users\A\Documents\ChatGPT\Forever_Skywalker_AI_Benchmark'
git status --short --branch
pnpm install --frozen-lockfile
pnpm check
pnpm test:e2e
pnpm trial --all
pnpm score:rehearse
```

平台类型/目录/131 项测试/生产构建、2 项浏览器端到端和真实性能配对链路均已通过。48/48 核心与 7/7 集成的参考可用分全部 50/50，缺陷均被声明检查检出，见 [55 题最终验收报告](trials/2026-09-14-full-fixture-audit.md)。`data/trials/2026-09-14T10-00-09-173Z` 是发现空评分组的首次审查记录，其结论已由后续回归取代，保留用于解释修复。

修改题目先冻结契约并提升版本，再跑 `pnpm task:verify <ID>`。必须起始缺陷在预声明项失败、参考与不同实现全部通过，才能标 fixture-ready。不能为了通过而删除失败项。改 catalog 后运行 `pnpm catalog:docs`。

## Linux 接续

用户已重启，Docker Linux引擎与固定镜像已就绪，详情见 [container-setup.md](container-setup.md)。日常使用 `pnpm container:status`、`pnpm container:verify` 与 `pnpm container:trial --all --alternatives`；不要每次评测都重建镜像。构建会更新.env的执行档案，保留裁判与访问令牌。

最终不可变image ID已保存在data/container/runtime.json，完整环境元数据及汇总在同目录；镜像含Node/.NET/Python/Chromium。没有容器即失败，不回退宿主。网络、CPU/内存/PID和回收已有真实验收，修改执行器后用container:verify重新确认。

## 裁判与发布校准

本项目 .env 已创建并配置本地访问令牌、提交目录和运行目录；DSH 评分 Agent 使用共用 DSH home 的供应商凭据，模型字段由用户填写。`BENCH_MEASURE_PERFORMANCE=1` 已启用；评分 Agent 配置完成后 submit 自动采集客观证据并调用两轮 DSH 评分，既有作答用 `bench review ... --measure` 追加修订。人工复核不覆盖历史。

PERF-02/03/04 有专用负载，其它题测完整验证成本并包含启动/断言开销。内部计时/RSS仅作诊断，外部阶段时间用于配对。性能比值和静态规则尚未发布校准，不能自动标正式成绩。

发布需真实正确/错误作答、固定容器噪声样本、裁判一致性和人工作答结果。没有这些证据时保持待校准。

## 模块与约束

| 位置 | 责任 |
| --- | --- |
| packages/contracts、core | 协议、50/50、等级与配对测量纯计算 |
| packages/catalog、tasks | 元数据、manifest、白名单导出、三向验证 |
| packages/runs、executor | 身份、快照、幂等、执行、回收、修订与报告 |
| packages/static、judge、evaluation | 静态事实、HTTP 裁判、证据组合与汇总 I/O |
| apps/cli、api、web | 操作入口和中文查询面板 |
| tasks/core、tasks/integration、graders | 对 AI 发布的题目包与受信验证资产 |

平台按单机单写者使用，不让多个 API/CLI 同时写同一个目录。容器中的隐藏检查仍可被候选读取；F#/Python 同进程检查与内部采样不能宣称防恶意篡改；本机候选拥有当前用户权限。哈希和标签不代替实际隔离。

非平凡变更在同批提交中附 [中文 Agent Note](notes/README.md)，写命令、结果和限制。未取得真实容器/裁判/校准证据，不把整个项目标为正式发布完成。
