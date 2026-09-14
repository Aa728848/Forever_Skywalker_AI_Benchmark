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

只在短生命周期子进程加载本地公开包接口：FileSettingsProvider（watch:false）、LlmRuntime、DeepSeek与Pi-ai目录适配器；调用listProviders/listModels/resolveModelInfo。FileSettingsProvider负责读取用户settings文档，查询助手不解析或转发原始配置。不会挂载credentials、agent/session、CLI、SDK服务器或Web服务，也不调用discoverModels/stream等远程入口。

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

来源接口已核对deepseek-harness的sdk/protocol/src/types.ts、apps/cli/src/profile-boot.ts、settings-file/src/index.ts、llm/src/index.ts及两个适配器的listModels/resolveModel实现。向导、启动脚本与用户文档由根任务集成。
