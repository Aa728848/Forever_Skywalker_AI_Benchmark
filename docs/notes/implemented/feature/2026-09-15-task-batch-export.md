# Agent Note: 批量导出题目工作区

Status: implemented

## Problem
外部编程 Agent 流程原先一次只能导出一道题，批量评测时需要重复执行命令并手动记录目录。

## Decision
`task:export` 保留原有单题形式，并增加 `--tasks ID1,ID2` 与 `--all`。批量模式在目标根目录下按题目 ID 建立独立工作区，同时写出 `batch-manifest.json`，列出目录与后续 `bench submit --by <agent-id>` 提交提示。

## Alternatives considered
没有把多道题复制到同一个工作区，以避免题目文件和依赖互相覆盖；没有修改题目包的导出白名单。

## Consequences
同一批次可交给多个 Agent 并行处理，每题仍使用现有冻结、验证和评分链路。目标根目录应使用新目录；已有 `batch-manifest.json` 的目录会被拒绝覆盖。

## Verification
运行 `pnpm task:export --tasks CACHE-02,API-04 <临时目录>`，成功生成两个题目目录及 `batch-manifest.json`。未调用真实模型或裁判。
