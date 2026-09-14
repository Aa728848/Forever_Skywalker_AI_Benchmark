# Agent Note: 质量维度合成与总分判定

Status: implemented

## Problem

评分标准规定每个质量维度 = 客观分 × 客观权重 + 评审分 ×（1 − 客观权重），
但 `scoreExecution` 此前把四个维度全部写死为 null：评审适配器已经有了（上一轮），
却没有一条代码路径把「客观分 + 评审分」合成维度分，也没有任何地方能算出 `total` 与 `thresholdMet`。

## Decision

- `packages/core` 新增 `QualityEvidence`（`objective` 每维带 `score`/`evidence`/`kind`，`review` 每维带 `score`/`evidence`）
  与内部 `composeQuality`：
  - 维度分 = `客观分 × qualityWeights[维度] + 评审分 × (1 − qualityWeights[维度])`，权重沿用 0.4/0.3/0.5/0.8。
  - 客观证据类型被冻结：`performance` 必须是 `benchmark`，其余三维必须是 `static`；类型不符该维度为 `null` 并在理由里写明。
  - 分数必须引用证据（客观与评审各至少一条），否则该维度为 `null`。
  - 任一维度缺失时 `quality` 为 `null`，**不做重新归一化**——这正是评分标准禁止的“缺测变成完整成绩”。
- `scoreExecution(execution, manifest, evidence?)` 现在按上式计算 `dimensions/quality`，并给出 `total`：
  只有 `functional` 与 `quality` 同时存在才计算；`thresholdMet` 只在 `total` 已知时按「总分 ≥70、可用验证 ≥40、关键项全过」判定，
  证据不全时仍保留“关键项失败 ⇒ 确定不合格”的结论。
- 理由文本明确写出缺哪些维度、缺哪一类证据（static/benchmark/review），便于面板与报告直接展示。

## Alternatives considered

- 只给客观分就出总分（评审缺失按 100 或按客观分顶替）：违反“不使用假设质量分”，未采用。
- 缺失维度按剩余权重归一化：会产出虚高总分，明确禁止。
- 允许任意证据类型参与客观分：评分标准要求性能客观分必须来自 benchmark，因此在代码里强制类型。

## Consequences

- 评分链路现在是完整的：受控执行 → 可用验证分；评审适配器 → 评审分；静态/基准证据 → 客观分；三者齐备才算总分。
- **仍然没有任何地方产出静态客观分或性能基准**（AST 复杂度、依赖边界、同机基准），
  所以真实运行的 `quality`/`total` 依旧为 null，需要下一轮补上客观分提供方与把评审结果写入运行档案。
- 预览评分（`mode=preview`）与正式评分（`mode=formal`）仍然在协议、存储与入口上分开。

## Verification

- `pnpm check`：exit 0（80 项 vitest）。
- 新增 5 项测试：客观 + 评审齐备时维度分 40/30/50/80、`quality=25`、`total=75`、`thresholdMet=true`；
  缺评审时该维度与总分保持 null 且理由点出 `performance`；性能维度给 static 证据被拒并说明类型；
  分数缺证据被拒；总分 20 时明确不合格。

