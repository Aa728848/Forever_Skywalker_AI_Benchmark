# Agent Note: DSH 工作区权限配置

Status: implemented

## Problem
DSH 自动测评需要明确模型可修改的文件边界，并让不同权限下的实验可复现；此前启动向导无法选择 DSH 沙箱权限。

## Decision
- 增加 `BENCH_DSH_WORKSPACE_PERMISSION` 与 `--workspace-permission`，支持 DSH 公开的 `read-only`、`workspace-write`、`danger-full-access` 三档，默认 `workspace-write`。
- 每次启动把选择映射为 DSH SDK 子进程环境变量 `DSH_PERMISSION_MODE`；不向 SDK initialize 伪造权限字段。
- 每题使用独立导出工作区作为 `workspace-write` 根目录，权限写入 `experiment.json` 并显示在 `report.md`；完整访问在向导中明确警告。
- 启动配置、命令行预检和适配器测试覆盖默认值、环境透传、显式优先级、非法值拒绝及实验记录持久化。

## Verification
- `node node_modules/vitest/vitest.mjs run apps/cli/src/launcher.test.ts packages/evaluation/src/dsh.test.ts packages/evaluation/src/dsh-comparison.test.ts`：30 项通过。
- 未调用真实作答模型或裁判；DSH 权限接口依据固定源码 `@deepseek-ai/dsh-sandbox-policy` 的公开环境配置。
