# API-03 · SSE 序列恢复与背压

- 难度：困难；题型：独立核心题；能力域：后端与服务协议。运行时：TypeScript on Node.js 24。题目版本：0.1.0。

## 背景

`starter/src/sse.ts` 解析服务端推送帧。断线重连后服务端会**重放**若干事件，网络也可能**丢帧**。
当前实现只看 id 不做判断：重放的事件被重复投递给界面（金额二次入账），丢帧则被静默吞掉。
请在**不改变公开接口**的前提下修复。

## 公开接口（冻结）

```ts
export interface SseEvent { readonly id: number; readonly data: string }
export class SequenceGapError extends Error { readonly expected: number; readonly received: number }
export class MalformedFrameError extends Error { readonly frame: string }
export class SseDecoder {
  push(chunk: string): readonly SseEvent[];
  end(): readonly SseEvent[];
  get lastId(): number;
}
```

## 必须满足的行为契约

1. 帧格式为若干行，其中必须含 `id: <非负整数>` 与 `data: <内容>`，帧之间以空行（`\n\n`）分隔；
   字段缺失抛 `MalformedFrameError`。
2. **跨块**：不完整的帧必须缓存到后续块，不得提前解析或丢弃。
3. **连续性**：新事件 id 必须等于 `lastId + 1`；跳跃抛 `SequenceGapError`（`expected`/`received`），且**失败不得推进 `lastId`**。
4. **幂等重放**：id 不大于 `lastId` 的事件一律**忽略**（不投递），随后更大的 id 仍按连续性规则处理。
5. `end()` 处理缓冲区里最后一个不完整帧；缓冲区为空（或只有空白）时返回空数组。

## 限制

- 只改 `starter/`；不得引入第三方依赖；不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

## 判定

- 参考实现通过全部公开与未公开检查；缺陷起始版本只被声明的检出项判失败；替代实现同样通过。
- 本阶段产出检查结论与可用验证分；代码质量评审接入前总分保持待定。
