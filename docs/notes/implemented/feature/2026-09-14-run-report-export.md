# Agent Note: 运行报告导出（Markdown + API 出口）

Status: implemented

## Problem

运行档案已经包含结论、逐项检查、评分与证据引用，但没有任何“人能直接看”的出口：
面板与人工复核都只能读 JSON 文件。目标判据要求提供报告导出。

## Decision

- `packages/executor` 新增 `renderRunReport(store, runId, attemptId): string`：
  把一次 attempt 的运行状态渲染成 Markdown——标题（题目与版本）、运行/尝试、阶段与执行结论、候选摘要、
  冻结/验证时间、**逐项检查表**（检查 id、分组、是否关键项、状态）、评分块（可用验证、代码质量、总分、质量维度、门槛、说明）、
  证据引用与 artifact 表（路径、字节数、摘要前缀），最后一行明确写出报告来自受控执行链、质量证据不全时保持待定。
- `apps/api` 新增 `GET /api/runs/:runId/:attemptId/report`，以 `text/markdown; charset=utf-8` 返回该报告；
  运行不存在时返回 404。
- 顺手修掉一个真实缺陷：报告出口先调用 `reply.type('text/markdown')` 再取内容，
  于是一旦取内容抛错，404 分支会用 text/markdown 序列化 JSON 对象而再次抛错，最终变成 500；
  现在先取内容、再设置 content-type。

## Alternatives considered

- 只在前端拼报告：面板与 CLI 会各写一遍格式，且报告无法被自动化流程消费；改为平台侧统一渲染。
- 直接返回 JSON 让调用方渲染：无法满足“报告导出”，也不便于人工复核。

## Consequences

- 一次运行现在有两条互补出口：结构化查询（`GET /api/runs/:runId/:attemptId`）与 Markdown 报告（`/report`）。
- 报告是**只读快照**：从冻结记录与执行结果读取，不重新计算分数，因此与 `score.json` 必然一致。
- 面板的时间线视图仍未实现（本轮只补了报告出口）；前端接入留到下一轮。

## Verification

- `pnpm check`：exit 0（87 项 vitest）。
- API 测试新增断言：报告返回 200 且 content-type 为 text/markdown、正文含 `# 运行报告 CACHE-02`、
  含失败检查 id `public/retry-after-failure`、含 `代码质量：待定`（说明缺陷候选没有质量证据）、
  含证据引用 `\`public.stdout\``；未知运行的报告请求返回 404。

