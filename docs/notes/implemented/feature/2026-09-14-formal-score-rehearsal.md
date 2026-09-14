# Agent Note: 正式分数端到端演练（可用验证 + 质量 + 总分）

Status: implemented

## Problem

评分链路的每一段都已经能跑（受控执行、静态客观分、评审适配器、合成规则），
但没有任何入口把它们串起来：CLI 的 `bench submit` 不会传入静态规则或评审判决，
因此真实提交永远只能得到可用验证分，`quality` 与 `total` 一直是待定。

## Decision

- `verifySubmission` 透传 `staticPolicy` / `review` / `quality` 三个可选输入给执行器（上一轮执行器已支持）。
- 新增 `scripts/score-rehearse.ts`（`pnpm score:rehearse`）：导出 CACHE-02、应用参考补丁、提交、
  注入静态规则 + 脚本评审判决 + 一个**显式标注**的 benchmark 客观分，打印完整正式分数与运行状态摘要。
- 顺手修掉一个真实缺陷：评分完成且无异常说明时，`RunStatus.scoring.reason` 会变成空字符串，
  违反协议（`text` 要求非空），导致状态查询直接抛错；现在回落为“按规则版本 … 计算，无异常说明”。

## Alternatives considered

- 让 CLI 直接连真实评审模型：需要用户配置的端点与凭据，且不适合作为仓库内的演练；
  演练先用脚本评审，真实评审留给 `BENCH_JUDGE_*` 配置后的路径。
- 把 benchmark 客观分写死进演练而不标注：会让读者以为性能维度已经有真实基准；
  脚本注释与本文都明确写出这是演练输入。

## Consequences

- 平台第一次产出**齐全的正式分数**：可用验证 50/50、质量 44.68/50、总分 94.68/100、门槛 `true`，
  证据引用里同时有检查原始输出与 `static.json`、`review.json`。
- 这次分数来自**参考实现 + 脚本评审 + 演练基准分**，是链路演示，不是某个真实 AI 作答的成绩；
  真实评审需要配置 `BENCH_JUDGE_*`，真实性能基准要接入 PERF 题的采样。
- F# 题在 TS 静态规则下会得到满分，仍未校准；接入 F# 规则前不得把该满分当质量结论。

## Verification

- `pnpm score:rehearse` 输出：执行结论 `passed`；可用验证 `50 / 50`；
  质量维度 `{simplicity:91, maintainability:86, decoupling:95, performance:85.4}`；
  代码质量 `44.68 / 50`；总分 `94.68 / 100`；门槛 `true`；证据引用含 `static.json` 与 `review.json`。
- `pnpm check`：exit 0（87 项 vitest）。

