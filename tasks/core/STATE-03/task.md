# STATE-03 · 检查点恢复和不可重复入账

- 难度：困难；题型：独立核心题；能力域：持久化与故障恢复。运行时：TypeScript on Node.js 24。题目版本：0.1.0。

## 背景

`starter/src/ledger.ts` 把金额写入日志并维护余额与检查点。崩溃后的恢复路径最容易出错：
当前实现**每次都从头重放整本日志**，于是已经入账的部分被重复计入——恢复一次余额翻倍一次。
请在**不改变公开接口**的前提下修复。

## 公开接口（冻结）

```ts
export interface Journal { append(entry: string): void; read(): readonly string[] }
export class LedgerError extends Error { readonly entry: string }
export function parseAmount(entry: string): number;
export class CheckpointStore {
  constructor(journal: Journal);
  get balance(): number;
  get checkpoint(): number;
  apply(entries: readonly number[]): number;
  recover(): number;
}
```

## 必须满足的行为契约

1. `apply(entries)` 把每个金额追加到日志、累加余额并把 `checkpoint` 推进到已入账条数，返回最新余额。
2. `recover()` 只重放**检查点之后**的日志条目；已经入账的绝不重复计入——重复调用 `recover()` 余额不变。
3. 进程重启后新建实例从同一本日志恢复，余额与检查点等于日志的全部有效内容（每个条目只入账一次）。
4. 日志里出现非整数条目时抛 `LedgerError`（`entry` 为该条目）。
5. `checkpoint` 只前进，等于已入账条数。

## 限制

- 只改 `starter/`；不得引入第三方依赖；不得使用真实计时器；不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

## 判定

- 参考实现通过全部公开与未公开检查；缺陷起始版本只被声明的检出项判失败；替代实现同样通过。
- 本阶段产出检查结论与可用验证分；代码质量评审接入前总分保持待定。
