# Agent Notes

记录本项目非平凡变更的原因、决定、备选方案、后果与验证证据。参考 cwtools-vscode 的 Agent Notes；当前项目的用户要求优先。

## 路径与封闭分类

`docs/notes/{lifecycle}/{class}/YYYY-MM-DD-slug.md`

生命周期：proposed（提议）、implemented（已交付）、rejected（否决）、archived（已取代）。

分类：feature、bug-fix、simplification、architecture、process、testing。不得自行增加分类，不建立全局 INDEX。

## 模板

```markdown
# Agent Note: 中文标题

Status: proposed

## Problem
问题、任务范围与必要性。

## Decision
设计决定；交付态只写已实现事实。

## Alternatives considered
比较过的方案及未采用原因，必填。

## Consequences
收益、约束与明确限制。

## Verification
实际运行的命令、结果及未完成的检查。
```

标题与正文使用简体中文，代码标识与章节字段保留原样。记录和相关非平凡代码变更一起交付。状态迁移时移动笔记；历史决定被取代时追加后继链接，不能把未实现功能写入 implemented 的完成清单。
