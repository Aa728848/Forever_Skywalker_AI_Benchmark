# Agent Note: 正式评分桥（执行结果 → 可用验证分）

Status: implemented

## Problem

平台此前只有预览评分（`bench score` 与 `/api/previews` 接受调用者提供的证据，`mode=preview`），
受控执行虽然已经产出逐项检查结论，却没有任何路径把它换算成分数：
`pnpm bench submit` 只能告诉你“哪些检查失败了”，不能告诉你有多少分。
评分标准里的 50/50、分组权重、关键项与待定规则因此一直停留在文档里。

## Decision

- `packages/contracts` 新增 `ExecutionScoreSchema`（`mode=formal`、分组明细、四个质量维度、`readiness`、`thresholdMet`、理由、证据引用），
  并把 `RunStatus.scoring` 从“固定 pending”升级为带 `functional/quality/total` 的摘要。
- `packages/core` 新增纯函数 `scoreExecution(execution, manifest)`（不引入文件、网络或模型调用）：
  - 五组权重用评分标准的 20/10/10/5/5；组内分 = 通过项权重和 / 组权重和 × 100，不做重新归一化。
  - **只认执行器产出的检查状态**：`passed` 计入，`failed` 记 0，`not-run` 不当作 0 也不当作满分。
  - `infrastructure-error` 与 `cancelled` 属于未完成执行：可用验证为 `null`、状态 `pending`/\`infra-error\`，只允许同一快照重试。
  - 被测失败（`check-failed`/`timeout`/`memory-exceeded`）按评分标准把未取得的项记 0（超时不再让整题变成“未取得结论”）。
  - 代码质量四个维度固定为 `null`（静态检查、性能基准与独立评审都未接入），因此 `total=null`；
    只有关键验收项明确失败时才给出确定的 `thresholdMet=false`，其余保持 `null`（待定）。
- `packages/executor` 在写 `execution.json` 之前计算评分，落盘 `execution/score.json`，把它加入证据引用，
  并追加 `score.finalized` 事件；`readRunStatus` 与 CLI/API 直接读出正式分数。
- `scripts/trial.ts` 也记录可用验证分，试跑报告从此带分数而不仅是结论。

## Alternatives considered

- 复用既有 `AssessmentSchema`/`ScoreResultSchema`（`mode=preview`）：那是“调用者自报证据”的输入协议，
  把它改成 formal 就等于用字段命名冒充可信度，因此新增独立的正式评分文档。
- 缺项按 0 归一化（把未跑到的检查直接从分母里去掉）：这正是评分标准禁止的“缺测重新归一化成完整成绩”。
- 把超时算作“未取得结论”：评分标准明确要求把算法导致的超时/OOM 记为被测失败，因此按 0 计入。
- 没有评审就让 `thresholdMet` 全是 `null`：那样连“关键项失败必然不合格”这个确定结论都拿不到，
  因此保留 `criticalPassed=false ⇒ 不合格` 的确定分支。

## Consequences

- 平台现在能给**可用验证分**（0–50）与分组明细，并且分数可追溯到执行结果与证据引用；
  代码质量与总分仍然待定，不会用假设分补齐。
- 缺陷起始版本在试点上的可用验证分落在 20.71–46.67 之间，参考实现稳定 50/50，分数具备区分度（这是制作期观察，不是校准结论）。
- 正式分数与预览分数在协议、存储与入口上完全分开：预览仍写 SQLite，正式分数写运行档案的 `execution/score.json`。
- 面板尚未展示正式分数（M2 的时间线一起做）。

## Verification

- `pnpm check`：exit 0（68 项 vitest）。
- `packages/core/src/scoring.test.ts` 新增 5 项：全通过=50 且总分待定；分组按权重折算且失败组记 0；
  关键项失败给出确定不合格；超时把未取得的项按 0 计入；基础设施故障与取消不给分数。
- `packages/executor/src/executor.test.ts`：缺陷候选的 `boundary` 组 weightPassed=2/5、可用验证分介于 0 与 50 之间、
  `criticalPassed=false`、`thresholdMet=false`；参考补丁候选 `functional=50`、五组均为 100；
  事件流新增 `score.finalized`（seq 3–7 序列断言）。
- `node scripts/trial.ts`：8/8 通过，缺陷端可用验证分 25.83 / 20.71 / 40.67 / 27.86 / 26.67 / 34 / 32.5 / 46.67，参考端全部 50。
- `GET /api/runs/:runId/:attemptId` 返回 `scoring.mode=formal` 与可用验证分；`bench submit` 输出可用验证、代码质量与总分三行。

