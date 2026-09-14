# Agent Note: 明确 DSH 报告保存位置

Status: implemented

## Problem
用户需要在启动测评后快速找到报告文件。此前命令只打印 Markdown 和 JSON 两个文件，未明确实验子目录及压缩证据路径；向导也只显示报告父目录。

## Decision
保留现有 `--output` / `BENCH_DSH_REPORT_DIR` 语义：父目录下按时间戳和随机 ID 创建独立实验目录。命令完成时打印实验目录及 `report.md`、`experiment.json`、`evidence.json.gz` 三个绝对路径；启动向导和使用文档同步说明默认位置及 `bench submit` 的独立 `data/runs` 目录。

## Alternatives considered
未将所有实验合并到单一固定文件或网页运行列表，避免覆盖历史结果并保持 DSH 自动比较与手工提交的存储边界。

## Consequences
用户可直接复制终端输出的路径打开报告；输出目录结构和清理策略保持不变。默认报告仍位于项目 `data/experiments`，也可由环境变量或 `--output` 改写。

## Verification
已更新 `scripts/dsh-compare.ts`、`apps/cli/src/launcher.ts`、`docs/quick-start.md` 与 `docs/dsh-comparison.md`。待父任务合并工作区其它权限配置后运行完整 `pnpm check`。
