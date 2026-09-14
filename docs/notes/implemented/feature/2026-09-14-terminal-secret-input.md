# Agent Note: 启动向导的隐藏输入

Status: implemented

## Problem

普通 readline 会把密钥输入回显，并可能写入方向键历史；向导需要可取消且不把密钥显示到计划命令。

## Decision

用 Node `readline/promises` 配合只在 secret 输入期间丢弃输出的 Writable，关闭历史记录，并让启动子进程使用显式环境对象。普通模型 ID 输入仍正常回显；密钥不进入 argv。

## Alternatives considered

没有引入终端 UI 依赖或依赖外部密码管理器；启动向导保持可在纯 PowerShell 中运行。没有把隐藏输入实现为全局 stdout 重定向，避免影响普通提示。

## Consequences

Windows 终端可以输入裁判/API 密钥而不显示内容；非交互管道和 EOF 会安全取消。控制台兼容性由 Node readline 负责，无法无损表达的环境值由 `.env` 保存模块拒绝。

## Verification

2项终端测试通过，覆盖退格、方向键、Ctrl+C、EOF 和普通输入恢复；全量 `pnpm check` 通过247项。
