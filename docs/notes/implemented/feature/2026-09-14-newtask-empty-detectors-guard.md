# Agent Note: 生成器防呆（拒绝写入空检出项）

Status: implemented

## Problem

`scripts/newtask.ts` 的自动收敛会在“起始版本实测失败项”与声明不一致时按实测重写 `defectDetectors`。
当起始版本**一条都不失败**时，实测集合是空数组，生成器会把空数组写进 manifest——
而协议要求 `defectDetectors` 至少一项，于是 `readManifest` 直接抛错，
验证输出连阶段行都没有，看上去像“检查阶段挂了”。CONC-01 第一轮就是被这个假象误导的。

## Decision

- 自动收敛前先判断实测集合是否为空：为空则**不写 manifest**、不推进状态，
  打印“起始版本没有任何失败项：缺陷注入或检查设计有问题，拒绝自动收敛，保持 designed 状态”并以退出码 1 结束。
- 保留原有的“新增/移除”差异日志，便于人工复核收敛结果。

## Alternatives considered

- 允许写入空数组并在 manifest 校验时给出更友好的错误：治标不治本，
  空检出项本身就意味着缺陷注入失败（起始版本没有可被检出的缺陷），应当直接挡住。

## Consequences

- 出题失败时会立刻得到明确诊断，而不是一个看起来像阶段故障的空输出。
- 这条规则与“没有题目包就不得标成 `fixture-ready`”一致：生成器只负责在证据齐备时推进状态。

## Verification

- `pnpm typecheck`：exit 0。
- `pnpm check`：exit 0（89 项 vitest）。

