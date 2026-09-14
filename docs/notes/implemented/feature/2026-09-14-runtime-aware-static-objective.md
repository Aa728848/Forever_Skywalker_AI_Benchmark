# Agent Note: 静态客观分按运行时适配（F# 题不再误判满分）

Status: implemented

## Problem

静态规则只实现了 TypeScript。对 F# 题（LSP-01、THR-03）来说，候选工作区里没有 `.ts` 文件，
于是三条规则全部给出满分——这不是“代码简洁、可维护、解耦良好”的结论，而是**没有可测量的对象**。
我之前两轮都把这写成遗留风险，本轮把它修掉：不能把“没测到”当成满分。

## Decision

- `packages/executor` 抽出纯函数 `staticObjectiveFor(task, report)`：
  - `task.runtime === 'typescript'` 时把 `simplicity/maintainability/decoupling` 三个 static 维度并入客观证据；
  - 其它运行时返回 `null`，并且执行器在运行说明里写明“静态规则只覆盖 typescript，本题运行时是 X：
    静态客观分未校准，保持缺失（不得当作满分）”。
- 静态报告仍然照常落盘（`execution/static.json` 与 `static.analyzed` 事件），
  因为它记录了本次实际测到的文件事实；只是这些事实**不参与**非 TS 题的质量分。
- 同样地，只有 typescript 题才会记入“静态客观分按规则版本 … 测量”的说明，避免在 F# 题上造成误解。

## Alternatives considered

- 现在就实现 F# 静态规则：需要 F# 的解析/度量工具与阈值校准，属于独立工作量；
  在规则冻结与校准之前先做“明确缺失”，比给出一个未校准的分数更诚实。
- 允许 F# 题用 TS 规则得到满分并在报告里加一行提醒：数值一旦出现就会被当成结论，未采用。

## Consequences

- F# 题的质量分现在**必然待定**，直到接入 F# 规则或被显式标注不可用；总分同样待定。
- TypeScript 题的行为不变（三个 static 维度照常参与合成）。
- 这条规则写进了代码注释与本文，后续实现 F# 规则时只要替换 `staticObjectiveFor` 的语言分支并提升规则版本即可。

## Verification

- `pnpm check`：exit 0（89 项 vitest）。
- 新增 2 项测试：typescript 题得到 `{simplicity:90, maintainability:80, decoupling:70}`（kind 均为 static、证据引用为 `static-report`）；
  fsharp 题返回 `null`（明确的“无可用规则”，而不是满分）。

