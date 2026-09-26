# Agent Note: 启动向导的本地DSH模型目录读取

Status: implemented

## Problem

用户希望终端分阶段选择供应商、模型、预设和思考等级，而不是手工拼接命令。目录读取必须保留provider与model二元身份，不能探测真实模型端点、展示凭据或创建作答会话。现有DSH SDK协议仅提供initialize/prompt/shutdown，没有模型目录查询方法；完整CLI启动的prepareProfile还会重写已有profile根文件，不适合只读查询。

## Decision

新增 `packages/evaluation/src/dsh-catalog.ts`：

```ts
discoverDshModels({ dshRoot, dshHome, profile? })
// Promise<{ providers: { id, name, models: { id, name, reasoningEfforts: string[] }[] }[], warning: string | null }>
```

只在短生命周期子进程加载本地公开包接口：LlmRuntime 与各目录适配器；调用 listProviders/listModels/resolveModelInfo。DSH 0.1.7 起 `settings-file` 已被 `@deepseek-ai/dsh-settings` 取代（该服务的注册接缝要求注入 `profileContext`/`configEditor`，本查询不启动 profile），因此**查询不再装载 settings 宿主插件**——适配器不需要它即可注册路由。适配器改为具名导出模块（导出 `apply`/`inject`），按模块命名空间交给 cordis 装载；DeepSeek 原生适配器的入口已从 `llm-deepseek` 移到 `llm-deepseek-api-key`。不会挂载 credentials、agent/session、CLI、SDK 服务器或 Web 服务，也不调用 discoverModels/stream 等远程入口。

子进程进入DSH模块前禁止网络连接、子进程派生、写文件及凭据存储/.env文件读取，忽略模块日志与原始异常；仅输出白名单目录字段。父进程再次验证并投影白名单，模型只在所属provider内去重，没有声明等级时返回空数组，由向导追加default。供应商同名模型不会相互合并。

查询限时12秒，输出上限2MiB；超时等待子进程终止后才返回手工输入提示并清理本次临时目录。错误提示不包含原始异常或配置文本。真实环境读取成功也明确提示目录范围：只描述本地DeepSeek/Pi-ai设置，不冒充额外插件及profile覆盖后的完整注册表；非标准sdk profile直接提供手工输入退路。

## Alternatives considered

- 调用不存在的SDK模型查询RPC：协议中没有此方法，不能推测接口。
- 启动完整CLI并注入查询插件：prepareProfile会重写已有配置，还会启动无关插件。采用仅目录服务的临时Context避免该副作用。
- 直接解析用户凭据或探测GET /models：不需要认证，也不符合只读本地目录要求。
- 复制供应商/模型目录与推理等级列表：会与DSH已安装目录和自定义模型设置漂移。直接使用对应适配器的公开能力接口。

## Consequences

标准SDK的DeepSeek/Pi-ai目录可以直接供向导选择；自定义插件路由保留明确手工入口。此列表不认证凭据、不证明远程模型可用，也不把未列出的模型ID判为禁止使用。护栏服务于已安装DSH本地模块的受限查询，不宣称其为恶意原生扩展的操作系统沙箱。

## Verification

- `pnpm exec vitest run packages/evaluation/src/dsh-catalog.test.ts`：7项通过，涵盖两个供应商共享模型ID、声明能力与空能力、白名单防配置泄漏、阻止凭据文件读取/写入/网络、错误/自定义profile手填退路。
- 真实不结算子进程测试在12秒超时后退出，查询临时目录清理；整套耗时12.57秒。
- `pnpm typecheck`通过。
- 本机实际安装读取成功：3个provider、5个model，只输出计数；没有模型或供应商网络调用，没有创建持久会话或重写profile。

来源接口已核对deepseek-harness的sdk/protocol/src/types.ts、apps/cli/src/profile-boot.ts、llm/src/index.ts及两个适配器的listModels/resolveModel实现。向导、启动脚本与用户文档由根任务集成。

## 预设枚举（同文件，2026-09-26 补充）

网页「配置」与「发起测评」此前把 standard/ptc/minimal/cordis 写死在组件里，无法反映本机实际安装。目录发现扩出一个只读预设枚举：读 `<dshRoot>/packages/bundle/web-app/presets/*.patch.yml`，解析每个 patch 里 `@deepseek-ai/dsh-agent-preset` 声明的 id/name/order，按 order 排序返回，并带相对安装目录的来源（不回传绝对路径）。目录不存在或全部解析失败时返回空列表与原因，由前端回退到内置四项并显示原因。

该目录**可直接按文件枚举**，无需启动 DSH 运行时、不联网、不调用模型，与既有目录发现边界一致。枚举只读取文件里的声明，**不验证该预设在本机能否装载**；DSH 另有一条需要在运行期注册的路径（插件把预设声明提交给活动注册表），那条路径不产生文件，本枚举看不到，因此不冒充完整列表。

失败必须可诊断（避免静默变空）：worker 的 stderr 保留有界片段，父进程用分类器压成结构性事实再进 warning。

**运行期注册的预设枚举不到**：DSH 另有两条预设来源，只有一条产生可枚举文件。bundle 声明（`presets/*.patch.yml`）是本枚举读取的那条；插件运行期注册（订阅渠道插件的 `dispatch` 即此类）把预设提交给活动注册表，**不写任何被 DSH 读取的文件**，因此本枚举看不到，也不应假装看到。

实测该插件在两种 profile 组合下的行为（真实插件、`apply()` 调用、临时 home）：

| 组合 | ctx.get('agentPresets') | 注册结果 | 落盘 | 插件日志 |
| --- | --- | --- | --- | --- |
| sdk（base + sdk-app + 订阅插件） | 无 | 未注册 | 写旧目录 `.agent-presets/dispatch` | 0 条 |
| web（含 web-app bundle） | 有 | 注册成功 `dispatch` | 不写旧目录 | 0 条 |

注册表行由 **web-app bundle** 提供（`base` 与 `sdk-app` 都不声明 `id: agent-preset-registry`），而 sdk 的 bundles 不含 web-app。因此两条路径分岔：web 组合有注册表服务，插件把 `dispatch` **注册进活动注册表**，不落任何文件；sdk 组合没有该服务，插件**静默降级**为写 `$DSH_HOME/.agent-presets/`，而 DSH 0.1.7 已不读该目录（其自带 `editing-cordis-compositions` 技能明写 “Nothing reads that directory any more”）。该降级**不打日志**（两种组合下插件都只走 info 级、本探针捕获 0 条），只能靠 `apply()` 的返回值或落盘差异区分。

上述耦合点已固化为可重复的体检命令（`pnpm dsh:doctor`，scripts/dsh-doctor.ts）：逐项核对 DSH 版本、九个运行期资产路径、当前 profile 的 bundle 组成、预设注册表行由谁声明、关键包能否从该 profile 解析、订阅插件与旧预设目录状态、固定镜像记录，并汇总需要同步适配的条目。它只读本地文件与已安装包，不联网、不调用模型、不写配置，且**始终以 0 退出**——体检报告不是判据，某些 FAIL 是本组合已知且有意的取舍。`@deepseek-ai/dsh-agent-preset` 包在 sdk 下**可以解析**（由 `profiles/node_modules` 里指向 DSH checkout 的 junction 提供），所以「重装插件」改变不了 sdk 的结果——缺的是注册表服务，不是包。
