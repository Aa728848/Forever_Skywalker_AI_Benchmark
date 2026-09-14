# Agent Note: 为未声明推理等级的DSH模型省略思考参数

Status: implemented

## Problem

用户询问不同供应商和同名模型如何测试。只读核对本地DSH文档与实现发现实际阻塞：手动添加的模型默认不声明reasoning元数据，DSH LlmRuntime.resolveCallWithInfo会拒绝任何显式reasoningEffort，连off也不例外。原比较入口始终传入等级字符串，因此这种已配置模型无法参与测试。

## Decision

新增比较模式default。`--reasoning default`、`--modes default,high`或`BENCH_DSH_REASONING_EFFORT=default`均支持；仅default在SDK launch中完全省略reasoningEffort属性，不把字符串default或undefined属性传入。原off/high/max等原样传递，未指定参数时仍保持原Off/High比较。

报告行的mode保留default，solver.requestedModel.reasoningEffort记录null，含义是本项目未指定等级，而非模型关闭思考。default和off保留独立分组、选择文件名和报告说明。presetFingerprint继续只代表预设内容；不以它宣称已验证供应商实际思考深度。observedRoutes仅含provider/model，因此不会把default当成必须返回的模型字段。

provider和model继续分别透传到DSH SDK，requestedModel与observedRoutes都保留二元身份。帮助文本和DSH比较文档补充该选项及自定义路由的reasoningEfforts前置条件，未改核心题库与评分协议。

## Alternatives considered

- 把off当成“不指定”：DSH明确拒绝未声明能力的模型携带任何显式等级，而且off与供应商默认可能不同。
- 对未知供应商静默删除High：会掩盖用户实际想测的模式。本次只有明确default才省略，其余仍由DSH校验。
- 将SDK中的default字符串作为等级发送：同样会触发UNSUPPORTED_REASONING_EFFORT，与省略字段不同。

## Consequences

未声明推理能力的模型现在可以沿用其供应商配置参加评测；能否连接与认证仍在真实运行时验证。default不构成固定实际思考深度，比较期间应固定供应商/模型配置。本次没有调用真实模型或读取用户私有凭据。

## Verification

已对照本地deepseek-harness的docs/user/guide/providers.zh.md、packages/llm/llm/src/index.ts和packages/llm/llm-pi-ai/src/adapter.ts确认拒绝条件；packages/sdk/client/src/api.ts在参数缺失时也会省略initialize中的reasoningEffort。

`pnpm exec vitest run packages/evaluation/src/dsh.test.ts packages/evaluation/src/dsh-comparison.test.ts`：22项通过。新增关键回归覆盖gateway-a/gateway-b使用相同模型ID，default完全省略字段、off/high保持原值，报告保存正确provider与null语义；已有真实本机评分编排回归继续通过，并确认default与off不混合均分。

`pnpm typecheck`通过。根任务随后执行最终pnpm check；这里不宣称真实供应商API已验收。
