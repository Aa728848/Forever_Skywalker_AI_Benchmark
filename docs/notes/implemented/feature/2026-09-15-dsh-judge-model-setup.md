# Agent Note: 裁判模型的 DSH 供应商与模型设置过程

Status: implemented

## Problem

正式质量分只由独立 DSH 评分 Agent 产生，但它的供应商与模型此前只能在 `.env` 里手写：环境补齐向导对 `BENCH_JUDGE_DSH_PROVIDER`/`BENCH_JUDGE_DSH_MODEL` 只给一句“填写供应商 ID/模型 ID”的文本提示，既没有本地 DSH 目录、也没有该模型声明的思考等级，且这段分支此前没有任何测试。`.env` 写入器又只补缺失/空值，配置过一次后想换裁判模型必须手工编辑文件。

## Decision

- 新增 `apps/cli/src/judge-dsh-setup.ts`：复用作答模型相同的目录发现（`discoverDshModels`，只读本地、不请求网络），依次选择供应商 →（按关键词过滤的）模型 → 该模型声明的思考等级，再补齐每轮输出上限、单轮超时与提示版本；目录不可用时退回手工输入。校验复用 `dshJudgeOptionsFromEnvironment`。
- 环境补齐向导的裁判分支改为调用该流程，仍只补缺失/空值；已配置完整时不读目录、不提问，但会做一次本地校验，已有但无效的非空值会被重新询问，不再因“已填写”而放行。
- 新增独立命令 `pnpm bench judge-setup`（启动菜单也新增“设置裁判模型”入口）：显示当前 DSH 评分 Agent、重走选择流程、列出待写字段，确认 `y` 后写回 `.env`。
- `saveProjectEnvironment` 新增显式 `options.replace`：只有被列出的字段才允许覆写已有非空赋值，其它键、注释与 CRLF 保持原样；默认行为（只补空值）不变。定位不到安全的值边界（例如多行引号值）时直接抛错，不猜测、不落盘。

## Alternatives considered

- 每次评分都用命令行参数指定裁判模型：会绕过 `.env` 的单一配置来源，也会让实验档案里的裁判指纹失去可追溯性。
- 让环境向导直接覆写已有值：与向导“只补缺失或空值、保留已有非空配置”的既有承诺冲突，因此仍由独立命令承担覆写。
- 允许手工编辑 `.env` 作为唯一途径：无法显示供应商/模型/思考等级的真实可用范围，容易写出 DSH 不认识的路由。
- 用远程目录或供应商 API 探测模型列表：会引入凭据与网络依赖，与“本地目录、不调用模型”的既有边界冲突。

## Consequences

- 选择裁判模型不再需要记住 ID；模型与思考等级来自本地声明的能力，减少写错路由导致的两轮判决失败。
- 覆写能力被限制在调用方显式列出的键上，并保留原有的并发冲突检测、无损编码校验与“整份文件重新解析必须与预期一致”的写前检查。
- 环境补齐向导的既有语义（只补空值）不变；想换裁判模型需要运行独立命令或先清空该字段。
- 设置过程只写本项目 `.env` 的裁判字段，供应商密钥仍留在共用的 DSH home。

## Verification

- `node node_modules/typescript/bin/tsc --noEmit`：通过。
- `node node_modules/vitest/vitest.mjs run packages/config/src/env-file.test.ts apps/cli/src/judge-dsh-setup.test.ts apps/cli/src/judge-setup.test.ts apps/cli/src/env-setup.test.ts --pool=threads`：4 个文件、40 项通过。（`.env` 写入器已迁到 `packages/config`，测试路径随迁移更新。）新增覆盖：目录选择（含 `fetch` 未被调用）、目录不可用手工填写、已完整配置不提问且不读目录、覆写模式默认值、无效非空值被重问、取消不改环境、独立命令确认/拒绝写入与保留注释、`.env` 的 `replace` 覆写与多行值拒绝。
- `launcher.test.ts`：新增“裁判模型入口只返回 `bench judge-setup`”用例通过；该文件另有 1 项既存的沙箱失败（`execFileSync` 的 `spawnSync EPERM`），与本次改动无关。
- 未调用任何模型或裁判；当前沙箱禁止以管道启动子进程，正常环境仍需重跑 `pnpm check` 复核。
