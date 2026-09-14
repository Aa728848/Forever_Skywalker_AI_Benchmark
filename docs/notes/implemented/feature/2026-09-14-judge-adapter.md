# Agent Note: 独立评审适配器（质量分的第一步）

Status: implemented

## Problem

评分标准里代码质量占 50 分，四个维度各由「客观分 × 权重 + 独立评审 × 权重」合成。
平台此前既没有评审协议，也没有评审适配器：`scoreExecution` 只能把四个质量维度全部置 null，
因此 `total` 永远是待定。要解锁总分，第一步是让「独立评审」成为一条受控、可校验、有预算的链路。

## Decision

- `packages/contracts` 新增两个文档类型：
  - `ReviewVerdictSchema`：runId/attemptId/taskId、`rubricVersion`、`model`、`promptVersion`、
    四维分数（每维必须至少引用一条证据）、notes、`cost`（调用次数与输入/输出 token）、评审时间。
  - `JudgeConfigSchema`：provider、model、endpoint、`promptVersion`、`maxCalls`、
    `maxInputTokens`、`maxOutputTokens`。
- 新包 `@fsa/judge`：
  - `judgeConfigFromEnvironment`：**只**从 `BENCH_JUDGE_*` 环境变量读取配置，令牌用
    `BENCH_JUDGE_TOKEN`；缺任何一项就抛 `JudgeUnavailableError`，不读取其它项目的私有凭据，
    也不把令牌写进配置对象或运行档案（配置里根本没有令牌字段）。
  - `createJudge(config, token, complete)`：把真正的模型调用注入进来，适配器只负责预算与校验——
    调用次数/输入/输出 token 任一超预算即 `JudgeBudgetExceededError`；判决必须符合协议、
    run/attempt 必须与请求一致、`promptVersion` 必须与配置一致，否则 `JudgeUnavailableError`。
  - `createScriptedJudge` + `sampleVerdict`：确定性脚本评审，用于测试与本地演练（明确不是正式分数来源）。

## Alternatives considered

- 在适配器里直接发 HTTP：会把网络与凭据塞进协议层，也难以在测试里构造「模型返回非法判决」；
  改为注入 `ReviewCompletion`，HTTP 实现留在调用方（后续的 provider 适配器）。
- 把令牌放进 `JudgeConfig`：一旦配置落盘就泄漏凭据；改为函数返回 `{ config, token }` 分离。
- 评审失败时回落成固定评语或 0.5：违反「不使用假设质量分」，因此一律抛错并保持待定。
- 现在就实现静态客观分：那是四维里另一半（40%/30%/50%/80% 权重），
  需要 AST 复杂度、依赖边界与性能基准；本轮先把评审链路做完整，不半途拼接出一个假总分。

## Consequences

- 评审链路现在可配置、可校验、可计费，而且**没有配置就不会运行**——不会静默产出质量分。
- 总分仍然待定：`scoreExecution` 的四个质量维度需要「客观分 + 评审分」同时存在才计算，
  静态客观分（AST 复杂度、依赖边界、性能基准）是下一个必须补的缺口。
- 令牌只存在于调用方的内存里；运行档案里只会有模型、提示版本与成本。

## Verification

- `pnpm check`：exit 0（75 项 vitest，含新增 7 项评审测试）。
- 评审测试覆盖：缺少环境变量与环境配置齐全两条路径、非法预算被拒、
  超过调用预算后拒绝、run/attempt 不一致被拒、提示版本不一致被拒、分数越界被拒、无证据被拒、
  脚本评审按序返回并累计成本。

