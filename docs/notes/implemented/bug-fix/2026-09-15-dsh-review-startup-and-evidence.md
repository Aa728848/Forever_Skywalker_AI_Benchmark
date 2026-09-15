# Agent Note: DSH 评分启动与执行证据修复

Status: implemented

## Problem

2026-09-15 的 CACHE-02 实验中，Linux 受控检查和性能采样均已完成，但评分会话启动失败：评分桥接插件访问 `ctx.tools` 时没有声明 `tools` 注入。失败堆栈随后被直接追加到执行 `notes`，超过协议的 2000 字符限制，掩盖了原始错误并把整次实验记录成“最终执行证据不符合协议”。

## Decision

评分桥接插件在 review-only 模式显式声明 `tools` 注入，使无工具限制在 DSH SDK 中按正确作用域安装。执行器遇到超长说明时，将完整说明写入同一执行目录的 `execution-notes.json`，在协议允许的 `notes` 中保留截断摘要和证据路径；执行协议失败消息同时包含结构化校验原因。

## Alternatives considered

删掉堆栈或把错误静默成简短文本会丢失排障证据；放宽协议说明长度会改变跨实现契约。因此保留完整证据并限制协议字段长度。

## Consequences

旧实验目录不会被改写；需要用同一作答目录重新评分或重新运行实验。正常评分仍需两个独立 DSH session 和有效模型返回，缺少这些证据时质量分继续待定。

## Verification

- `node node_modules/vitest/vitest.mjs run packages/evaluation/src/dsh.test.ts packages/evaluation/src/evaluation.test.ts packages/evaluation/src/dsh-judge.test.ts packages/evaluation/src/dsh-comparison.test.ts`：4 个测试文件、33 项通过。
- 使用本地假 SSE（不调用外部模型）运行真实 DSH SDK 评分适配器两轮：DSH `0.1.5-rc.1`、两轮路由一致、每轮 `tools=0`、均返回 `completed`，临时目录已清理。
