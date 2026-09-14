# Agent Note: BND-03 题目包（跨字节块的 Unicode 与流解析）——困难档首题

Status: implemented

## Problem

流式接口按块收到字节，多字节字符会被拆到两块里。若解码器**每块独立解码、不保留跨块状态**，
中文名与 emoji 会在流式响应里随机损坏——这类缺陷在本地一次性读全量数据时永远复现不出来。

## Decision

- 冻结 `StreamDecoder`（`push`/`end`/`offset`）与两种错误：`InvalidUtf8Error`（带**全局字节偏移**）、
  `IncompleteSequenceError`。
- 缺陷族只有一条：**不保留跨块状态**。非法字节的校验在起始版本里就是对的（fatal 解码器 + 包装成 `InvalidUtf8Error`），
  因此每阶段只失败与“跨块拆分”相关的检查。
- 参考实现用 `TextDecoder('utf-8', { fatal: true })` 的 `stream: true` 增量解码，`end()` 收尾；
  替代实现自己维护待续字节缓冲、按首字节推断序列长度（**完全不依赖 TextDecoder 的流式能力**，结构不同）。
- 偏移语义写进契约：`InvalidUtf8Error.offset` 是整条流中的起始字节偏移，而不是块内偏移——
  这是排查线上问题时真正需要的定位信息。

## Alternatives considered

- 让起始版本不校验非法字节（用替换字符兜底）：那会同时打掉“非法字节”检查，缺陷族扩散。
- 只测 `中`（3 字节）：4 字节 emoji 的边界不同（首字节 0xF0..0xF4），必须单独覆盖，因此两类都进了检查。

## Consequences

- 困难档开始，核心题 27/48；中等档 11/12（只剩 F# 的 LSP-02 与 mixed 的 THR-02）。
- 本题确立的“跨块状态必须保留”契约，与后续 API-03（SSE 序列恢复与背压）属于同一族问题，可复用检查形态。

## Verification

- `node scripts/task.ts verify BND-03`：六阶段通过——起始版本只被 6 个同族检出项判失败，
  参考实现与替代实现全部通过。
- `pnpm check`：exit 0。

