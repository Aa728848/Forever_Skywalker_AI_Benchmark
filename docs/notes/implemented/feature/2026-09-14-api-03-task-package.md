# Agent Note: API-03 题目包（SSE 序列恢复与幂等重放）

Status: implemented

## Problem

服务端推送在断线重连后会**重放**若干事件，网络也可能**丢帧**。只看 id 不做判断的实现有两个后果：
重放事件被重复投递（金额二次入账、界面重复条目），丢帧被静默吞掉（数据缺口无人知晓）。

## Decision

- 冻结 `SseDecoder`（`push`/`end`/`lastId`）与 `SequenceGapError`（带 `expected`/`received`）、`MalformedFrameError`。
- 缺陷族只有一条：**不校验序列连续性、不忽略重放**。跨块缓存与非法帧校验在起始版本里就是对的，
  因此每阶段只失败这两项。
- 参考实现把三种判断收进一个 `#accept`：`id <= lastId` 忽略、`id > lastId + 1` 抛错、否则收下并推进；
  替代实现先切分全部完整帧再逐帧走同样三步（结构不同）。
- 契约里写明“**失败不得推进 `lastId`**”：否则一次丢帧之后所有后续事件都会被误判，那是比丢帧更糟的状态。

## Alternatives considered

- 遇到丢帧就去重同步（跳过缺失事件继续）：会掩盖数据缺口，必须显式报错交由上层决定是否重连。
- 把跨块缓存也做成缺陷：与 BND-03 重复，且会让缺陷族扩散。

## Consequences

- 困难档 4/12；核心题 28/48。
- “拒旧 / 查新 / 收下”这三步现在同时出现在 API-03 与 BND-03 的隐藏检查里，成为平台级流式处理的统一契约。

## Verification

- `node scripts/task.ts verify API-03`：六阶段通过——起始版本只被 4 个同族检出项判失败，
  参考实现与替代实现全部通过。
- `pnpm check`：exit 0。

