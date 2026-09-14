# Agent Note: bench submit 接上静态规则与评审配置状态

Status: implemented

## Problem

`bench submit` 此前没有任何质量证据入口：即使平台已经能算静态客观分与合成质量分，
命令行提交也只会得到可用验证分，而且输出里的“代码质量”是一句写死的“未接入”，
无法区分“没配置评审”“只有静态分”“缺 benchmark 客观分”这几种完全不同的状态。

## Decision

- `packages/static` 导出 `defaultTypeScriptPolicy()`：一套**明确标注未校准**的起步阈值
  （每函数决策点 12、每函数 60 行、禁止 `node:child_process` 与 `node:worker_threads`），
  注释写明“正式发布前必须按题族用真实作答分布校准并提升规则版本”。
- `bench submit` 新增 `--static`：启用该策略，把三个 static 维度并入客观证据。
- `bench submit` 每次都会打印评审配置状态：
  - 未配置时明确写出“需要 BENCH_JUDGE_ENDPOINT / BENCH_JUDGE_MODEL / BENCH_JUDGE_TOKEN，代码质量保持待定”；
  - 已配置时打印 provider/model/提示版本/预算，并说明 **CLI 尚不自动调用评审**，判决需由调度器注入。
- 把“代码质量：未接入（…）”改为直接展示评分链给出的真实理由，因此输出会点名缺哪些维度、缺哪类证据。

## Alternatives considered

- 让 CLI 自己调用评审模型：runId/attemptId 在提交时才生成，判决必须与之一致；
  正确的位置是调度器（拿到冻结记录后）再取判决，因此 CLI 只报告配置状态。
- 用写死的阈值当成正式规则：阈值未校准，必须在题族上校准后才能作为正式门槛；本轮显式标注。

## Consequences

- 命令行提交现在能推进到“可用验证 + 三个静态维度”，但**总分仍然待定**——
  因为性能维度需要 benchmark 客观分、四个维度都需要评审分，两者都还没有入口。
- 这条路径把“缺什么”直接写在输出里，避免读者把待定误解成“没实现”。

## Verification

- `pnpm check`：exit 0（89 项 vitest）。
- `pnpm bench submit CACHE-02 <候选> --key static-demo --static` 实测输出：
  评审状态行正确报告未配置；执行结论 `check-failed`；可用验证 `40.67 / 50`；
  证据引用包含 `static.json` 与 `score.json`；代码质量与总分按规则保持待定。

