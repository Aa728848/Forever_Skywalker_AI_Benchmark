# API-03 · SSE 序列恢复与背压

- 难度：困难；题型：独立核心题；能力域：后端与服务协议。运行时：TypeScript on Node.js 24。题目版本：0.1.1。

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

## 字节流、背压与重连接口（0.1.1）

`starter/src/byte-stream.ts` 的 ByteSseStream 在相同帧格式上增加真实 UTF-8 字节输入和有界消费队列，保留上述 SseDecoder 接口。

```ts
export class BackpressureError extends Error {}
export interface StreamOptions { readonly capacity: number; readonly maxBufferedBytes: number; readonly fromId: number }
export class ByteSseStream {
  constructor(options: StreamOptions);
  push(chunk: Uint8Array): void;
  end(): void;
  drain(max: number): readonly SseEvent[];
  get queued(): number;
  get lastId(): number;
}
```

- UTF-8 字符可以在任何字节边界拆分；无效或 end 时截断的 UTF-8 必须报错，不能用替代字符静默损坏内容。
- capacity 是未消费事件数上限；入队将超限时抛 BackpressureError。maxBufferedBytes 限制“未闭合帧字节数 + 本次 push 的字节数”；超限也必须失败，调用方可把大输入拆成小块。
- 解析、序列或预算错误使该流进入失败态，后续 push/end/drain 继续抛出该错误，不能交付部分损坏结果。
- drain 按顺序最多交付 max 项，消费后释放队列容量。lastId 只推进到真正 drain 的最后一项，未消费预读不得推进重连游标。
- fromId 是已交付的保留游标；重连重放不大于已接收游标的事件不得重复入队，新事件必须连续。队列空时 lastId 仍等于 fromId。
- capacity、maxBufferedBytes、drain max 必须为正安全整数，fromId 必须为非负安全整数；非法配置抛 RangeError。end 后可 drain，不能继续 push。

## 限制

- 只改 `starter/`；不得引入第三方依赖；不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

## 判定

- 参考实现通过全部公开与未公开检查；缺陷起始版本只被声明的检出项判失败；替代实现同样通过。
- 本阶段产出检查结论与可用验证分；代码质量评审接入前总分保持待定。
