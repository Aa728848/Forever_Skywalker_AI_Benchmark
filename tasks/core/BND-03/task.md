# BND-03 · 跨字节块的 Unicode 与流解析

- 难度：困难；题型：独立核心题；能力域：参数与边界解析。运行时：TypeScript on Node.js 24。题目版本：0.1.0。

## 背景

`starter/src/decoder.ts` 逐块解码字节流。当前实现**每块独立解码、不保留跨块状态**：
一个多字节字符只要被拆到两块里，就会解码失败或产生替换字符——中文名、emoji 因此在流式响应里随机损坏。
请在**不改变公开接口**的前提下修复。

## 公开接口（冻结）

```ts
export class InvalidUtf8Error extends Error { readonly offset: number }
export class IncompleteSequenceError extends Error {}
export class StreamDecoder {
  push(bytes: Uint8Array): string;
  end(): string;
  get offset(): number;
}
```

## 必须满足的行为契约

1. `push` 返回**本次新增的完整字符**：末尾未完成的多字节序列必须保留到下一次 `push`，不得解码、不得报错、不得产出替换字符。
2. 跨块边界必须对 2、3、4 字节字符都成立（`中` = 3 字节、`🚀` = 4 字节）。
3. 非法字节序列抛 `InvalidUtf8Error`，`offset` 为该序列**在整条流中的起始字节偏移**（从 0 开始计数）。
4. `end()` 返回剩余内容；若仍有未完成序列则抛 `IncompleteSequenceError`。`end()` 之后再 `push` 抛 `IncompleteSequenceError`。
5. `offset` 是已接收的字节总数；不得修改调用方传入的 `Uint8Array`。

## 限制

- 只改 `starter/`；不得引入第三方依赖；不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

## 判定

- 参考实现通过全部公开与未公开检查；缺陷起始版本只被声明的检出项判失败；替代实现同样通过。
- 本阶段产出检查结论与可用验证分；代码质量评审接入前总分保持待定。
