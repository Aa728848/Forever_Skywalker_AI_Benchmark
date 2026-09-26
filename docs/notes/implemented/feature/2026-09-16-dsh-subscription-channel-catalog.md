# Agent Note: 订阅渠道插件的 DSH 模型目录发现

Status: implemented

## Problem

启动向导（pnpm start → DSH 自动作答）与 pnpm bench judge-setup 都用 discoverDshModels 读取本地 DSH 模型目录。原实现只在独立子进程里装载 settings.yaml、llm 运行库和内置的 DeepSeek/pi-ai 适配器，因此只能看到“模型列表里”的供应商；订阅渠道（ChatGPT 订阅 codex-chatgpt、Command Code、Kimi Code 等）由 DSH profile 已安装的插件提供路由，不会出现在列表里，用户只能手工输入，容易写错 ID。

## Decision

1. 目录发现改为按“当前 BENCH_DSH_PROFILE”读取该 profile 的 package.json 中 dsh.profile.bundles，只对**位于 DSH 安装目录之外**的本地插件包解析其 exports/main 运行时入口（优先 default/import/module/node/require 条件，跳过 .d.ts），并把入口 URL 传给目录 worker；worker 用 ctx.plugin() 装载它们，再枚举 ctx.llm.listProviders()/listModels()/resolveModelInfo()。
2. 目录 worker 不再无条件阻断文件写入，而是把可写范围收窄到**本次查询的临时 DSH home**；仍然禁网（fetch、http/https、net、tls、dgram 全阻断）、禁子进程、禁读 .credentials*/.env*/auth/token 文件。
3. 父进程为每次查询复制真实 home 的 settings.yaml 到临时 home，并以 DSH_HOME=<临时 home> 启动 worker。插件把凭据与模型设置物化在 $DSH_HOME 下，于是写入只落在临时目录；用户的真实 DSH home 只读，查询结束整目录回收。
4. worker 为插件声明注入的宿主服务提供惰性占位（webServer、tools、attachments、loader、web）：注册类调用返回可释放句柄，真正产生副作用或读取数据的调用直接抛错，不返回假数据。缺少这些服务会让插件停在 pending，路由完全不可见。
   - 其中 **settings 必须提供，但刻意不带 register**：订阅渠道的 settings-compat 用 hasRegister(settings) 在两条存储路径间选择——有 register 就走本次进程的内存命名空间作用域（空），没有才回落到插件自己的文件存储 `$DSH_HOME/storages/<provider>-models.json`。目录查询要读出真实已登录状态，必须让它走文件存储。
   - 父进程把真实 home 的 `storages/*-models.json` 一并复制进临时 home（只取该模式的文件，凭据与账户池一律不复制）。这些适配器的 listModels 在 enabled=false 或勾选集为空时返回空数组，缺这份状态会让已登录的订阅渠道显示 0 个模型。
5. 插件装载失败不阻断其它目录：目录协议只回传失败插件的标识（不回传原因，避免配置或凭据片段进入日志），并在 warning 中提示这些路由请手工填写。
6. 未初始化或未通过名称校验的 profile 直接返回手工输入提示，不再假装读取了原生目录。

## Alternatives considered

- **把订阅渠道插件装进 sdk profile**：需要 dsh plugin add 与 --allow-build，且要求用户额外维护一份安装；已写入文档作为等价选项，但不作为默认。
- **用 Web profile 启动自动作答**：实测该 profile 能在自动作答的 SDK 会话里装载，但会绑定 127.0.0.1:3080，与正在运行的 DSH 网页界面冲突（本地实测 EADDRINUSE）；且它的 patchReload 是 live，会挂 HMR 与服务网络，不符合“启动冻结、只依赖显式 patch”的评测边界。已作为文档中的备选如实记录，但不作为默认。
- **直接复用用户真实 home 运行 worker**：插件会就地读写真实凭据与 storages，查询变成有副作用的操作，不能接受。
- **保留文件系统全阻断、只给插件注入假 store**：需要按插件逐个适配，且仍无法覆盖插件自己的初始化路径。
- **在父进程内直接 import 插件**：ESM 模块缓存会让多个 profile 的同一插件包无法隔离，且插件会真实写用户 home。

## Consequences

- 目录现在包含订阅渠道，但**不验证凭据、额度或远程可用性**：没有登录过的订阅渠道仍会列出模型，选中后由 DSH 在运行时报告未登录。
- 只有装进**当前 profile** 的插件才可见。默认 sdk profile 不包含订阅渠道时，目录行为与改动前一致；用户可选择安装插件、改用其它 profile，或继续手工输入。
- 查询允许在临时 DSH home 内发生写入，可写范围由 worker 的路径守卫限定为该临时目录；凭据文件仍不可读。
- 查询仍是纯本地读取，不发起任何网络请求，也不使用模型。
- 失败必须可诊断：worker 的 stderr 保留有界片段，父进程用分类器压成**结构性事实**（缺失的资产路径、无法解析的模块、装载失败的插件）再进 warning，并提示「DSH 可能已改名或移动该路径，需同步适配」。异常原文一律不回传——插件异常可能带凭据或本机路径；第一版直接把原文写进 warning 时被既有的不泄漏用例当场拦下。

## Verification

- packages/evaluation/src/dsh-catalog.test.ts 12 项通过：新增“把当前 profile 已安装的本地插件路由并入目录”“插件装载失败只提示该插件”“插件按 DSH home 物化凭据时只落在临时目录”“尚未初始化的 profile 返回手工输入提示”，并保留原有禁网、禁读凭据、12 秒超时回收等用例。
- 真实本机验证（node --import tsx，未调用模型、未联网）：BENCH_DSH_PROFILE=web 时目录为 deepseek-official / antigravity / kimi-code / command-code / codex-chatgpt（codex-chatgpt 带 low/medium/high/xhigh/max）；sdk 时为 deepseek-official，与改动前一致。
- 另用真实 DSH SDK 对 web profile 做了启动握手（不发 prompt）：它确实能装载，只因网页界面已占用 127.0.0.1:3080 而失败；该事实已写入文档。
- 在**临时 DSH home** 上做完整安装实验（未触碰真实 home，未调用模型）：`dsh plugin --profile sdk add file:...` 成功，但 SDK 启动握手对 `codex-chatgpt/antigravity/command-code/kimi-code` 一律报 `no adapter registered for provider`。原因是插件声明注入 `webServer`，而 `sdk` profile 不挂载该服务，插件整体停在 pending，`apply` 从未执行；在 `profiles/sdk/cordis.patch.yml` 插入一个 `@deepseek-ai/dsh-host-webserver`（`port: 0`）后，四个订阅路由全部解析成功，`sdk` 的入口行只增加这一条，`web` profile 的清单与 node_modules 不变。该两步结论已写入 docs/quick-start.md。
- pnpm check 全量通过：275 项测试、类型检查、目录检查与 Web 生产构建。
