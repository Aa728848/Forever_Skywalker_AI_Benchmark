# STATE-03 · 检查点恢复和不可重复入账

- 难度：困难；题型：独立核心题；能力域：持久化与故障恢复。运行时：TypeScript on Node.js 24。题目版本：0.2.0。

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

## 0.2.0 事务日志、确认丢失与恢复原子性

保留 CheckpointStore。在 starter/src/transactional-ledger.ts 实现 TransactionalLedger(journal:Journal)，公开 balance/checkpoint、recover():number、commit(id:string,amounts:readonly number[]):Receipt。Receipt={id,balance,checkpoint}，记录该事务首次确认时的结果；同键同金额重试返回原回执，同键不同金额抛 TransactionConflictError。

- 日志每条是一个完整交易 JSON：{version:1,id,amounts}。id 是非空白字符串；金额及每一步累计余额必须是安全整数，允许负数和空金额数组。非法新请求以 RangeError 拒绝且不得写日志。
- 一次 commit 将整个交易追加为一条记录。Journal.append 可能在写前抛错，也可能已经完整持久化后丢失确认并抛错；系统必须重新读取事实，已持久化返回回执，否则原样传播写入错误，重试不重复入账。
- recover 校验完整日志后才发布余额、checkpoint和去重状态；坏JSON、错误字段/版本、重复交易id、余额溢出、已有确认前缀的改写或截断都抛 JournalCorruptError。失败保持上一次确认快照。调用方可修复坏尾再恢复。
- 一个日志只允许一个写者，日志可在调用间追加；不要求多主协调或机器断电原子性。新进程从完整日志恢复，不能依靠跨实例全局去重。检查包含真实文件与在append落盘后立即退出的子进程。
