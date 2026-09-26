# Agent Note: 质量维度合成与总分判定

Status: implemented

## Problem

评分标准规定每个质量维度 = 客观分 × 客观权重 + 评审分 ×（1 − 客观权重），
但 `scoreExecution` 此前把四个维度全部写死为 null：评审适配器已经有了（上一轮），
却没有一条代码路径把「客观分 + 评审分」合成维度分，也没有任何地方能算出 `total` 与 `thresholdMet`。

维度集合后来从四个减为三个（2026-09-26 移除 `performance`），原因见 Decision 末条。

## Decision

- `packages/core` 新增 `QualityEvidence`（`objective` 每维带 `score`/`evidence`/`kind`，`review` 每维带 `score`/`evidence`）
  与内部 `composeQuality`：
  - 维度分 = `客观分 × qualityWeights[维度] + 评审分 × (1 − qualityWeights[维度])`，权重为 0.4/0.3/0.5（simplicity/maintainability/decoupling）。
  - 客观证据类型被冻结为 `static`；类型不符该维度为 `null` 并在理由里写明。
  - 分数必须引用证据（客观与评审各至少一条），否则该维度为 `null`。
  - 任一维度缺失时 `quality` 为 `null`，**不做重新归一化**——这正是评分标准禁止的“缺测变成完整成绩”。
  - 维度分允许显式 `null`（2026-09-26）：裁判按提示词可在无法判断时拒绝给分，下游让该维保持待定，不当作 0。
  - 每维满分为 `qualityTotalPoints / 维度个数`（现为 `50/3`），由 `packages/contracts` 导出。质量分刻度恒为 50，增删维度时自动保持——删维不得缩小刻度或改写 50/50 基线。
  - **`performance` 维度已移除**：本项目的受控验证成本配对实测测量的是**验证链路耗时**（含启动与断言成本），不是候选代码本身的性能，用它给候选打分名不副实；而题目普遍没有独立性能负载（55 题中 0 题有 `benchmark.ts`），该维必然缺证据，使 `total` 永远待定。配对实测仍在采集并写入 `benchmark-samples.json`，作为发布校准的环境事实与参考/候选对照证据，只是不再产生维度分。
- `scoreExecution(execution, manifest, evidence?)` 现在按上式计算 `dimensions/quality`，并给出 `total`：
  只有 `functional` 与 `quality` 同时存在才计算；`thresholdMet` 只在 `total` 已知时按「总分 ≥70、可用验证 ≥40、关键项全过」判定，
  证据不全时仍保留“关键项失败 ⇒ 确定不合格”的结论。
- 理由文本明确写出缺哪些维度、缺哪一类证据（static/benchmark/review），便于面板与报告直接展示。

## Alternatives considered

- 只给客观分就出总分（评审缺失按 100 或按客观分顶替）：违反“不使用假设质量分”，未采用。
- 缺失维度按剩余权重归一化：会产出虚高总分，明确禁止。删维**不是**归一化——它是改变评分口径，因此质量分刻度固定为 50，而不是把三维压成 37.5。
- 允许任意证据类型参与客观分：客观分必须来自静态分析，因此在代码里强制类型。
- **保留 performance 维度并给它一个基线**（否决）：需要为每题提供同口径参考实现与可信性能负载，而现有配对实测度量的是验证链路耗时。若将来题目真正带上 `benchmark.ts` 与校准阈值，应作为一次独立的协议变更重新引入该维，而不是让它在缺证据的情况下拖住总分。

## Consequences

- 评分链路现在是完整的：受控执行 → 可用验证分；静态客观分 + 评审适配器 → 三维质量分；两者齐备才出总分。
- 真实运行的 `quality`/`total` 现在可以落地：三维的客观分由静态分析提供，评审分由裁判适配器提供。
  `pnpm score:rehearse` 实测三维 91/86/95 → 质量 45.33/50、总分 95.33/100。
- 缺证据仍然保持待定：任一维的客观或评审一侧缺席时该维为 `null`，`quality` 与 `total` 均为 `null`。
- 预览评分（`mode=preview`）与正式评分（`mode=formal`）仍然在协议、存储与入口上分开。

## Verification

- `pnpm check`：exit 0（358 项 vitest，含本 Note 相关用例）。
- 三维版本的核心用例：客观 + 评审齐备时维度分 40/30/50、`quality=20`、`total=70`、`thresholdMet=true`；
  三维满分时 `quality=50`、`total=100`（删维不缩小刻度）；某维裁判声明不可判时该维为 null 且总分待定；
  分数缺证据被拒；总分 20 时明确不合格。
- 端到端：`pnpm score:rehearse` 输出质量 45.33/50、总分 95.33/100、门槛 true；
  `packages/executor` 的落盘用例实测三维齐备时 `quality=44`、`total=84.67`（此前因缺 performance 恒为 null）。

