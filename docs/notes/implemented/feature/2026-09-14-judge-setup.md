# Agent Note: 分步裁判配置表单

Status: implemented

## Problem

裁判配置字段多且按供应商不同，空环境下手工填写容易漏掉思考参数、预算或协议；同时密钥不应出现在普通终端回显中。

## Decision

`collectJudgeSetup(io, env)` 按缺失字段询问供应商、端点、模型、隐藏令牌、供应商支持的思考字段和预算。非空已有值不重问、不覆盖；跳过返回空更新，取消返回 `null`。最终调用既有 `judgeConfigFromEnvironment` 与 `createEnvironmentJudge` 做本地参数校验，不发网络请求。错误只允许重填当前可编辑字段，提示会脱敏令牌。

## Alternatives considered

没有让用户在命令行直接传令牌，也没有复制一套供应商校验规则或自动探测端点。模型 ID 由用户填写，避免猜测供应商最新目录。

## Consequences

支持8家原生供应商及 OpenAI-compatible，思考等级与预算可在同一流程中配置；未知或未配置项可跳过，完整质量分按现有规则保持待定。密钥只通过终端 secret 通道传给上层保存。

## Verification

15项表单测试通过，覆盖供应商、思考映射、既有值保留、错误重填、取消/跳过及空令牌；没有真实模型或网络调用。
