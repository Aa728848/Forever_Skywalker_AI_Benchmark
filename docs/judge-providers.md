# 裁判供应商与推理参数

核对日期：2026-09-14。本文对应 `packages/judge` 的实际实现。当前完成的是官方协议映射和模拟 HTTP 验收，没有使用真实凭据、没有产生模型调用或模型成绩。

## 配置入口

正式评分链使用独立 DSH 评分 Agent。HTTP `BENCH_JUDGE_ENDPOINT/TOKEN` 兼容代码仍保留用于历史材料和离线迁移，但不会被 `createQualityProvider()` 自动调用。

评分 Agent 与作答 Agent 共用 DSH 的 `BENCH_DSH_ROOT`、`BENCH_DSH_HOME`、`BENCH_DSH_PROFILE`、`BENCH_DSH_WORKSPACE_PERMISSION`；只有模型路由和思考参数单独配置：

```dotenv
BENCH_JUDGE_DSH_PROVIDER=deepseek-official
BENCH_JUDGE_DSH_MODEL=独立的评分模型ID
BENCH_JUDGE_DSH_REASONING_EFFORT=high
BENCH_JUDGE_DSH_MAX_TOKENS=16384
BENCH_JUDGE_DSH_TIMEOUT_MS=300000
BENCH_JUDGE_PROMPT_VERSION=dsh-review-v1
```

评分默认使用 `minimal` 的无工具评分配置，并要求两轮使用新的 DSH session。工作区权限仍从 DSH 链传入；建议设为 `read-only`。评分 Agent 不读取隐藏检查、参考补丁或其它作答，无法解析 JSON、身份/证据不匹配、超时或回收失败都会保持质量分待定。

DSH 评分 Agent 只需在本项目 `.env` 填入 `BENCH_JUDGE_DSH_PROVIDER`、`BENCH_JUDGE_DSH_MODEL` 与思考/预算字段；供应商密钥继续由共用的 DSH home 管理。旧 HTTP 入口的端点与令牌不参与自动评分。

以下参数矩阵属于历史 HTTP 兼容适配器，供导入旧评审材料使用；正式自动评分不读取这些字段。所有供应商共用同一裁判提示、材料和判决 Schema，但各家的“high”不代表相同算力。模型名称、思考模式、输出限制和采样参数共同决定裁判配置。

### 历史 HTTP 兼容配置（非自动评分默认路径）

| 环境变量（均以 `BENCH_JUDGE_` 开头） | 含义 |
| --- | --- |
| `PROVIDER` | `openai`、`anthropic`、`gemini`、`deepseek`、`qwen`、`xai`、`moonshot`、`zhipu`；旧 `openai-compatible` 保留 |
| `API` | 留空使用下表默认协议；OpenAI 另可选择 `chat-completions` |
| `REASONING_EFFORT` | 枚举档位，按厂商和登记模型能力校验 |
| `REASONING_MODE` | OpenAI GPT-5.6 Responses 的 `standard` / `pro` |
| `THINKING` | `enabled` / `disabled`；Claude 的部分模型另支持 `adaptive` |
| `THINKING_BUDGET` | 思考 token 控制；Claude 手动模式、Gemini 2.5、Qwen 的语义各不同 |
| `TEMPERATURE` / `TOP_P` / `TOP_K` / `SEED` | 只发送显式配置且该适配器支持的采样参数；`seed` 不保证确定性 |
| `VERBOSITY` | OpenAI 的 `low` / `medium` / `high`，与思考深度分开 |
| `OUTPUT_FORMAT` | `json-object` 发送原生 JSON 输出控制；`prompt-json` 由提示要求 JSON。两者均严格校验本地判决 Schema |
| `STREAM` | `true` / `false`；Kimi 默认 `true`，其余默认 `false`。此版只支持 Chat Completions 的 SSE |
| `MAX_TOKENS_PER_CALL` | 每次请求的输出限制；留空在创建适配器时取 `floor(MAX_OUTPUT_TOKENS/MAX_CALLS)`，之后保持固定 |
| `MAX_CALLS` / `MAX_INPUT_TOKENS` / `MAX_OUTPUT_TOKENS` | 本次裁判实例的总调用、总输入与总输出预算，输出按包含思考的实际 usage 统计 |
| `TIMEOUT_MS` | 1–3600000 毫秒；原有默认 60000 保留，复杂思考可显式加大 |
| `PROMPT_VERSION` | 默认 `review-v1`，改变提示时应提升版本 |

留空的采样/思考字段不会被硬塞成统一默认值，报告中的 `parameters` 展示实际发送的参数。供应商默认行为仍可能随模型别名变化；发布校准优先使用可用的固定模型快照。参数拼错、未登记的组合或任意 JSON 透传均拒绝工作。

### 历史 HTTP 适配器的思考参数（不用于 DSH 评分）

修改项目根目录 `.env` 中已有的对应字段。例如使用本适配器已登记的 DeepSeek 裁判：

```dotenv
BENCH_JUDGE_PROVIDER=deepseek
BENCH_JUDGE_ENDPOINT=https://api.deepseek.com
BENCH_JUDGE_MODEL=deepseek-v4-pro
BENCH_JUDGE_TOKEN=填写你自己的裁判API密钥
BENCH_JUDGE_THINKING=enabled
BENCH_JUDGE_REASONING_EFFORT=high
BENCH_JUDGE_MAX_TOKENS_PER_CALL=16384
BENCH_JUDGE_MAX_OUTPUT_TOKENS=32768
BENCH_JUDGE_TIMEOUT_MS=300000
```

此适配器对上述 DeepSeek 模型支持 `low`、`high`、`max`；关闭思考时改为 `BENCH_JUDGE_THINKING=disabled`，并清空 `BENCH_JUDGE_REASONING_EFFORT=`。不要在裁判的 effort 字段填 `off`。其它供应商使用下方矩阵中对应的等级或预算字段；切换供应商时清空旧供应商专属参数。

保存后运行 `pnpm bench judge-config` 本地检查，查看 `parameters` 中实际准备发送的思考参数；该命令不调用模型。新启动的 `pnpm dsh:compare` / `pnpm bench` 会重新读取 `.env`；正在运行的 API 服务需重启后生效。同名系统或终端环境变量优先于 `.env`，应同步修改或清除已有覆盖值。

这些设置只控制**裁判**。DSH 作答模型、标准/PTC/极简/创造模式和作答思考等级由 [DSH 比较入口](dsh-comparison.md) 单独配置。比较作答模式时保持裁判参数不变；裁判的思考等级会写入报告配置并参与指纹，不同指纹不能混入同一汇总。

## 已实现的供应商矩阵

| Provider / 默认协议 | 思考控制 | 输出与采样边界 |
| --- | --- | --- |
| OpenAI / Responses | `reasoning.effort`；Chat 使用 `reasoning_effort`。GPT-5.6 Responses 可加 `reasoning.mode` | Responses 使用 `max_output_tokens`、`text.format`、`text.verbosity`、`store=false`；Chat 使用 `max_completion_tokens`、`response_format`、`verbosity`。GPT-6 Astra 拒绝 temperature/top_p。[推理指南](https://developers.openai.com/api/docs/guides/reasoning)、[当前模型参数](https://developers.openai.com/api/docs/guides/latest-model) |
| Anthropic / Messages | 手动模式 `thinking={type:enabled,budget_tokens:N}`；适应模式 `thinking={type:adaptive}`，深度为 `output_config.effort` | 手动预算至少 1024 且小于 `max_tokens`；adaptive 不带手动预算。此版思考模式拒绝采样参数；非思考模式 temperature 0–1，temperature 与 top_p 不并用。输出采用 prompt-json，本地 Schema 强校验；尚未接入原生 `output_config.format`。[手动思考](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)、[Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)、[Effort](https://platform.claude.com/docs/en/build-with-claude/effort) |
| Google Gemini / generateContent | Gemini 3 使用 `generationConfig.thinkingConfig.thinkingLevel`；Gemini 2.5 使用 `thinkingBudget`，二者互斥 | 使用 `maxOutputTokens`、`responseMimeType=application/json`、temperature/topP/topK/seed；不开启 thought summaries。2.5 Pro 不能设预算 0；动态预算 -1，Flash 可 0，Flash-Lite 正数至少 512。[GenerateContent 参数和 usage](https://ai.google.dev/api/generate-content)、[分模型思考配置](https://ai.google.dev/gemini-api/docs/generate-content/thinking) |
| DeepSeek / Chat Completions | `thinking.type=enabled/disabled`；新版 `deepseek-flash/pro/v4-*` 的 `reasoning_effort=low/high/max` | 使用 `max_tokens`。拒绝思考模式中会被忽略的 temperature；top_p 只接受思考模式 0.95–1。拒绝 medium/xhigh 到 high 的静默映射；旧模型未登记 effort 时不能强行使用。[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)、[Chat API](https://api-docs.deepseek.com/api/create-chat-completion/) |
| Qwen / DashScope 的兼容 Chat 接口 | `enable_thinking`、`thinking_budget`；不是 OpenAI 的 reasoning_effort | 使用 `max_tokens`。Qwen 商业思考模型有同步支持；未登记同步支持的开源思考模型要求 stream=true。部分旧思考模型的 JSON Object 不可靠，默认 prompt-json；明确禁用思考或登记的 3.7/3.8 模型可用 json-object。[深度思考](https://www.alibabacloud.com/help/en/model-studio/deep-thinking)、[结构化输出](https://www.alibabacloud.com/help/en/model-studio/qwen-structured-output) |
| xAI / Chat Completions | Grok 4.6 `low/medium/high/xhigh`；4.5 `low/medium/high`；Grok 3 Mini `low/high` | 使用 `max_tokens`，未登记 effort 的 Grok 模型不能设置该项。4.5 的 xhigh 会被服务映射为 high，因此本地拒绝。多 Agent 的 effort 含义不同，本适配器不登记该模型。[Reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning) |
| Moonshot/Kimi / Chat Completions | K2.5/2.6 用 `thinking.type`；K2.7 Code 不能禁用；K3 用 `reasoning_effort=low/high/max` 且不能设 thinking | 默认 SSE + usage。K2.5/2.6 只允许与模式一致的固定采样值（思考 temperature=1，关闭=0.6；top_p=0.95）；K3 不接受本适配器的采样参数。两轮分别请求，不传上一轮思考历史。[Thinking Models](https://platform.kimi.ai/docs/guide/use-thinking-models)、[K2.6 参数](https://platform.kimi.ai/docs/guide/kimi-k2-6-quickstart)、[Benchmark 建议](https://platform.kimi.ai/docs/guide/benchmark-best-practice) |
| Zhipu/GLM / Chat Completions | GLM 4.5 及以上使用 `thinking.type=enabled/disabled` | 使用 `max_tokens`、temperature 0–1、top_p 0.01–1；此版采用 prompt-json，不传未知 reasoning_effort/thinking_budget。[官方 Chat API](https://docs.z.ai/api-reference/llm/chat-completion) |

`openai-compatible` 表示用户所选网关承诺兼容原 Chat Completions 契约，保持旧接口，不代表平台已验证网关所有模型能力。已识别的厂商请选对应 provider。当前不接 AWS Bedrock、Azure 身份链、Vertex AI、工具调用、图片材料或任意供应商扩展 JSON。

OpenAI 能力登记按模型分开：GPT-5.1 没有 xhigh；GPT-5 Pro 仅 Responses/high；GPT-5.4 Pro 仅 Responses/medium/high/xhigh；GPT-5.5 为 none/low/medium/high/xhigh；GPT-5.6 Sol 为 none/low/medium/high/xhigh/max；GPT-6 Astra 为 low/medium/high/xhigh/max。未知模型的额外推理参数应先核对再扩展登记，不能用笼统的 `gpt-5.*` 推断。[5.1](https://developers.openai.com/api/docs/models/gpt-5.1)、[5 Pro](https://developers.openai.com/api/docs/models/gpt-5-pro)、[5.4 Pro](https://developers.openai.com/api/docs/models/gpt-5.4-pro)、[5.5](https://developers.openai.com/api/docs/models/gpt-5.5)、[5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol)、[6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)

## 历史 HTTP 配置样例（非 DSH 自动评分）

下列模型名仅用于展示映射，不是最佳裁判推荐，也不保证你的地区或账户可调用。先填写共同预算，再从下表选择一行；切换厂商时清空不适用的可选字段。

```dotenv
BENCH_JUDGE_MAX_CALLS=2
BENCH_JUDGE_MAX_INPUT_TOKENS=120000
BENCH_JUDGE_MAX_OUTPUT_TOKENS=32768
BENCH_JUDGE_MAX_TOKENS_PER_CALL=16384
BENCH_JUDGE_TIMEOUT_MS=300000
BENCH_JUDGE_TOKEN=自行填写
```

| Provider | Endpoint 示例 | Model 示例 | 额外 BENCH_JUDGE_* 配置 |
| --- | --- | --- | --- |
| openai | `https://api.openai.com/v1` | `gpt-5.5` | `REASONING_EFFORT=high`、`VERBOSITY=low` |
| anthropic | `https://api.anthropic.com/v1` | `claude-sonnet-4-6` | `THINKING=adaptive`、`REASONING_EFFORT=high` |
| gemini | `https://generativelanguage.googleapis.com/v1beta` | `gemini-2.5-pro` | `THINKING_BUDGET=8192` |
| deepseek | `https://api.deepseek.com` | `deepseek-v4-pro` | `THINKING=enabled`、`REASONING_EFFORT=high` |
| qwen | 控制台所属地区和工作空间的 `…/compatible-mode/v1` | `qwen3.5-plus` | `THINKING=enabled`、`THINKING_BUDGET=8192`、`STREAM=true`、`OUTPUT_FORMAT=prompt-json` |
| xai | `https://api.x.ai/v1` | `grok-4.6` | `REASONING_EFFORT=high` |
| moonshot | `https://api.moonshot.ai/v1` | `kimi-k2.6` | `THINKING=enabled`、`STREAM=true` |
| zhipu | `https://api.z.ai/api/paas/v4` | `glm-5.1` | `THINKING=enabled` |

Qwen 的地区、WorkspaceId、密钥和模型可用范围必须匹配控制台。国内智谱可填自己账户的官方兼容基址；本项目不会自动改路由或读取别的项目的密钥。

## 证据、费用与失败行为

每轮保存 `configuration`（provider、api、请求 model、promptVersion、实际参数、参数指纹）、实际 token 用量、可选用量分解和服务返回的 `responseModel`。指纹也包含端点身份，但报告不包含端点明文。缓存同时绑定配置、材料与轮次；同轮重发复用结果，第二轮是独立调用。服务返回的快照名单独记录，不能替代用户配置或证明供应商实际算力。

OpenAI、DeepSeek、Qwen、Kimi、GLM 与 Claude 的输出总数采用服务的 inclusive 输出字段，reasoning 明细不再相加。Claude 输入量合并未缓存、缓存创建和缓存读取三部分；Gemini 输入字段已含缓存，输出为 total − prompt，并核对 candidates + thoughts。只有真实返回的 usage 才能产生判决；这不是供应商账单的货币价格估算。

每轮生成上限是发送给该协议的输出字段；供应商对思考预算的解释以其接口为准。总 token 预算按实际 usage 校验，超过后不产生该轮判决并停止继续。它不能撤销已发生的服务计费。高 effort 和小输出上限可能只产出思考而没有完整 JSON，因此不能把“没有正文”当作 0 分或让第二轮偷偷增加预算。

HTTP 错误、超时、取消、断流、缺少最终 stop/DONE、缺 usage、拒绝、工具调用、空正文、截断、JSON/标识/证据校验不通过都会保持待评。未知消费的失败不会自动重试。模型返回的思考文本与签名不落盘；流式解析只累积最终正文，整个响应限制 16 MiB。

本轮离线验收覆盖 8 厂商协议参数、原生响应、SSE 跨 UTF-8/CRLF 分块、思考 usage、参数互斥、模型特例、两轮参数固定和缓存隔离；真实端点兼容性、一致性和评分质量仍需要用户另行启动正式校准。
