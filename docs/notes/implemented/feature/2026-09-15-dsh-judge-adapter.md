# Agent Note: DSH 评分会话适配器

Status: implemented

## Problem

HTTP 自动路由裁判在真实评审中容易因端点、超时或协议差异保持待定，且评分 Agent 的工作区配置没有与 DSH 作答链统一。用户要求只保留一条能复核的 DSH 评分路径。

## Decision

新增 `@fsa/evaluation` 的 `createDshJudgeFromEnvironment`。每轮评分创建新的 DSH SDK session，使用独立评分模型和思考等级；root、home、profile、workspace permission 沿用 `BENCH_DSH_*` 配置。评分 session 使用 review-only 预设，禁止工具调用，材料作为不可信数据嵌入提示，严格校验 ReviewVerdict 的身份、版本和 evidence ID。两轮结果还要保持 DSH 版本、预设指纹和路由一致；HTTP 裁判不再是质量评分默认路径。

## Alternatives considered

保留自动路由作为默认或让评分 Agent 访问候选工作区都可能导致协议漂移、工具副作用和不可复核结果，因此未采用。无法取得实际 token usage 时记录 `null`，不以文本长度或 0 猜测费用。

## Consequences

评分模型必须在 DSH home 中可用，并通过 `BENCH_JUDGE_DSH_PROVIDER/MODEL/REASONING_EFFORT` 单独配置；与作答模型相同的 provider+model 会被拒绝。评分失败、超时、非法 JSON、身份或证据错误保持质量分待定。正常评分临时工作区和 DSH runtime 会回收；SDK close 未确认时保留现场。

## Verification

`node node_modules/vitest/vitest.mjs run packages/evaluation/src/dsh-judge.test.ts packages/evaluation/src/evaluation.test.ts`：6 tests passed。使用注入的 DSH harness 验证合法/fenced JSON、证据校验、两轮独立 session、只读权限透传与无工具 review-only 标志；未调用真实模型。
