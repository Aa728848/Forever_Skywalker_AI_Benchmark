# Agent Note: 静态与评审证据接入运行档案

Status: implemented

## Problem

静态客观分与评审适配器都已经能用，但它们没有进入运行档案：
`executeAttempt` 从不接收质量证据，`execution/score.json` 里四个维度永远是 null，
而且评审判决、静态违规清单这些原始材料没有落盘，事后无法复核。

## Decision

- `executeAttempt` 新增三个可选输入：`staticPolicy`（静态规则）、`review`（评审判决）、`quality`（调用方补充的客观/评审证据，例如性能维度的 benchmark 客观分）。
- 给出 `staticPolicy` 时：对**物化后的工作区**跑一次静态测量，写 `execution/static.json`，
  把三个 static 维度（简洁度/可维护性/解耦性）并入客观证据，并追加 `static.analyzed` 事件（含规则版本、分数与违规条数）。
- 给出 `review` 时：写 `execution/review.json`（原样保留模型、提示版本、四维分数与证据引用、成本），
  并入评审证据，并追加 `review.finished` 事件（actor 为评审模型）。
- 两份文件都加入 `artifacts` 与 `evidenceRefs`，因此 `score.json` 的分数可以回溯到具体材料。
- 性能维度仍**只能**由 benchmark 客观分提供：调用方明确给出时才补齐；否则该维度为 null、
  `quality`/`total` 保持待定——这条边界由评分桥的合成规则强制，不靠约定。

## Alternatives considered

- 在执行器里直接调用评审模型：会把凭据与网络塞进执行链，也会让「执行」与「评审」两类副作用混在一起；
  改为调用方（CLI/API/后续的调度器）先取得判决再传入。
- 把静态报告只留在内存：事后无法复核规则版本与违规清单，因此必须落盘。
- 缺 benchmark 时用静态分顶替性能维度：评分标准要求性能证据必须来自 benchmark，未采用。

## Consequences

- 一次提交现在可以产出完整链条：`execution.json`（结论与逐项检查）→ `static.json`（结构信号与违规）→ `review.json`（独立评审）→ `score.json`（可用验证 + 质量 + 总分）。
- `bench submit` 还没有拿到静态规则与评审判决的入口：需要 CLI 侧接上 `BENCH_*` 配置并把判决传进来，
  这是下一步；在那之前，真实提交的 `quality`/`total` 仍然是待定（如实）。
- F# 题在 TS 规则下会得到满分的静态分，属于未校准状态；接入 F# 规则或被显式标注前不得当作质量结论。

## Verification

- `pnpm check`：exit 0（87 项 vitest）。
- 新增执行器测试：给出静态规则 + 评审判决后，`static.json` 与 `review.json` 都出现在 artifacts 与 evidenceRefs 中，
  事件流包含 `static.analyzed` 与 `review.finished`，`dimensions.simplicity` 是数字、
  而 `dimensions.performance`、`quality`、`total` 仍为 null 且理由点出 `performance`——证明缺 benchmark 时不会伪造总分。

