# STATE-01 · 原子写入与损坏检测

- 难度：简单；题型：独立核心题；能力域：持久化与故障恢复。运行时：TypeScript on Node.js 24。题目版本：0.1.0。

## 背景

`starter/src/store.ts` 是一个按 key 存放文本记录的文件存储。当前实现直接覆盖写入、没有校验和，
并且把空内容当成“不存在”。请在**不改变公开接口**与**磁盘格式**的前提下修复。

## 公开接口与磁盘格式（冻结）

```ts
export interface RecordStore { write(key: string, value: string): void; read(key: string): string | null; close(): void }
export class CorruptRecordError extends Error { readonly key: string }
export class StoreClosedError extends Error {}
export function openRecordStore(directory: string): RecordStore;
```

- 每个 key 对应一个文件 `<directory>/<key>.rec`，内容是 JSON：`{ "checksum": string, "value": string }`。
- `checksum` 是 `sha256(value)` 的小写十六进制；`value` 是原始字符串。
- 键必须是 `[A-Za-z0-9._-]+`。

## 必须满足的行为契约

1. `write` 必须原子：先把完整记录写入同目录的临时文件，再改名为 `<key>.rec`；写入失败时不得留下临时文件或半截正式文件。
2. `read` 必须校验：文件不是合法 JSON、或缺 `value`/`checksum`、或 `checksum` 与 `sha256(value)` 不一致时，抛 `CorruptRecordError`（`key` 为对应键）。
3. 缺失的键返回 `null`；空字符串是合法值，写入 `''` 后 `read` 必须返回 `''`。
4. 非法键抛 `RangeError`（不得写到目录之外）。
5. `close()` 之后 `read`/`write` 抛 `StoreClosedError`；重复 `close()` 是安全的。
6. 覆盖写后读到新值；内容包含换行、中文与 emoji 时往返一致。

## 限制

- 只改 `starter/`；不得引入第三方依赖；不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

## 判定

- 参考实现通过全部公开与未公开检查；缺陷起始版本只被声明的检出项判失败；替代实现同样通过。
- 本阶段产出检查结论与可用验证分；代码质量评审接入前总分保持待定。
