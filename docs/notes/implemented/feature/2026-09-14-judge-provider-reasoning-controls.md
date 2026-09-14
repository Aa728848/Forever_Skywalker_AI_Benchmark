# Agent Note: 裁判供应商与思考参数接入

Status: implemented

## Problem

原裁判只发送兼容 Chat Completions 请求，不能配置思考深度、手动思考预算和厂商特有参数。只记录模型名无法复现两个评审轮次的生成配置；按剩余预算动态计算每轮上限还会改变第二轮参数。

## Decision

核对并实际打开 OpenAI、Anthropic、Google、DeepSeek、阿里云、xAI、Moonshot 和智谱的官方接口/模型文档，来源及核对日期写入 `docs/judge-providers.md`。新增厂商白名单、4 种协议、明确生成字段和互斥校验，保留旧兼容入口。OpenAI 按已登记模型区分 effort，不能把 GPT-5.1、Pro 或新模型混为一个正则范围；DeepSeek 和 Grok 会被服务静默降级的设置在本地拒绝。Claude 区分 enabled+budget 与 adaptive+effort，Gemini 区分 2.5 budget 与 3 level。

HTTP 适配使用原生 fetch，无新 SDK。Chat SSE 支持分块 UTF-8/CRLF、终止和 usage 校验；Kimi 默认采用 SSE。只保存最终 JSON、生成配置及参数指纹、实际用量和返回模型名，思考内容/签名不落盘。Claude 缓存输入和 Gemini 思考输出按各自 usage 语义计算，未返回的明细保持缺省，不编造 token 分解。

两轮输出限制在适配器创建时冻结；剩余额度不足则停止，不调整第二轮参数。缓存绑定完整配置、材料和轮次。端点仅参与摘要，明文端点和令牌不写进评审结果。配置拼写错误、任意 JSON 透传、截断/断流/缺 usage 均拒绝产生成绩。

## Alternatives considered

- 统一发送 reasoning_effort：Claude/Gemini 字段不同，部分厂商会忽略或映射该参数，无法准确复现，因此未采用。
- 透传任意 extra_body 或引入多供应商 SDK：会扩大无法审计的请求范围或增加依赖，此次只实现用户需要的确定字段。
- 自动修复 JSON、回退模型或重试：失败请求可能已计费且改变评审条件，继续保留人工可见的待评状态。

## Consequences

可独立配置裁判思考强度、采样与输出上限，但同名档位不等于跨供应商相同算力。Claude/GLM 此版采用 prompt-json 与本地 Schema 校验，没有宣称原生 JSON Schema 已接入。未登记的模型调参需核对官方模型页后补登记；旧 openai-compatible 的网关能力由配置方确认。非 Chat 原生 SSE、工具、多模态、云平台身份链未在此次范围内。

没有修改或读取项目实际 `.env`，没有调用真实模型，也没有进行 Linux 或模型正式试跑。协议模拟通过不意味着裁判一致性已经校准。

## Verification

- `node node_modules/vitest/vitest.mjs run packages/judge`：2 个文件、53 项测试通过；覆盖 8 厂商映射、原生响应、SSE 完整性、模型特例、互斥、缓存、两个固定参数轮次及 token 预算。
- `node node_modules/typescript/bin/tsc --noEmit`：通过。
- 根任务继续负责评价层落盘/双轮指纹接线及完整项目回归；本 Note 不把这些尚未返回的结果计为完成证据。
