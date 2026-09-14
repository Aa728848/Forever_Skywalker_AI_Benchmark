# CONC-04 · 持久分片归并、崩溃恢复与代际发布

- 难度：极度困难；题型：独立核心题；能力域：异步并发。
- 运行时：TypeScript on Node.js 24（依赖 Node 原生类型剥离，仅可使用可擦除语法）。
- 题目版本：0.2.0；评分规则版本：0.1.0。

## 背景

`starter/` 是一个可独立运行的最小项目，`starter/src/job-runner.ts` 把一批作业事件应用到检查点，
并为每个生效事件执行一次外部副作用。当前实现先执行副作用再写检查点，也不做事件去重，
进程崩溃后重放会重复执行副作用、迟到事件还会覆盖新状态。请在**不改变公开接口**的前提下修复。

## 公开接口（冻结，不得修改签名、导出名与文件路径）

```ts
export interface JobEvent { readonly id: string; readonly seq: number; readonly kind: 'add' | 'commit' | 'cancel'; readonly payload?: string }
export interface JobStore { read(key: string): string | null; write(key: string, value: string): void }
export interface EffectLedger { has(effectId: string): boolean; apply(effectId: string): void }
export interface ApplyOutcome { readonly applied: string[]; readonly skipped: string[] }
export const checkpointKey = 'job-runner/checkpoint';
export class JobRunner {
  constructor(store: JobStore, effects: EffectLedger);
  apply(events: readonly JobEvent[]): ApplyOutcome;
  resume(events: readonly JobEvent[]): ApplyOutcome;
  state(): { readonly committed: string[]; readonly pending: string[]; readonly lastSeq: number };
}
```

## 必须满足的行为契约

1. 事件按 `(seq, id)` 升序处理；每个事件生效时产生一个副作用，副作用 id 等于事件 id。
2. 同一事件 id 只生效一次：重复出现记入 `skipped`。
3. 迟到事件：`seq` 小于等于已处理最大 `seq` 的事件必须忽略并记入 `skipped`，不得覆盖更新的状态。
4. 状态语义：`add payload` 加入 `pending`；`commit payload` 从 `pending` 移到 `committed`；`cancel payload` 从 `pending` 移除；`payload` 缺省时状态不变但事件仍然生效。
5. 副作用恰好一次：`effects.has(id)` 为 true 时不得再 `apply`；重复事件、重放与恢复都不得重复执行。
6. 崩溃恢复：检查点必须先持久化再执行副作用；副作用之后崩溃时，`resume()` 不得再次执行该副作用；副作用之前崩溃时，`resume()` 必须补做且只做一次。
7. `state()` 只反映存储中已持久化的状态（`committed` / `pending` / `lastSeq`），构造 `JobRunner` 不得读写副作用账本。
8. `applied` 是本次真正生效的事件 id（按处理顺序）；`skipped` 是被跳过的事件 id（按处理顺序）。

## 限制

- 答案范围限于 `starter/`；不要修改 `public-tests/`。
- 不得引入第三方运行时依赖；不得依赖进程内全局状态或定时器。
- 只能使用可擦除的 TypeScript 语法：不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

在**工作区根目录**运行：

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

## 判定

- 参考实现通过全部公开与未公开检查。
- 注入目标缺陷的起始版本必须被检出（失败项限于预先声明的检出项），其余已正确行为不得回归。
- 与参考实现结构不同的替代实现也必须通过同一契约。
- 本阶段只产出检查通过或失败；代码质量评审接入前总分保持待定。

## 0.2.0 持久分片归并与恢复

新增starter/src/shard-merge.ts，保留原JobRunner接口和回归。ShardMerge(root,hook?) 提供 prepare(generation,runId,shards)、completeShard(runId,shardId)、pending(runId)、publish(runId):boolean、resume(runId):boolean、snapshot():{generation:number|null;runId:string|null;lines:readonly string[]}。Shard={id:string;lines:readonly string[]}，generation非负安全整数，runId/shardId非空且分片ID不重复。prepare冻结顺序和内容，重复同runId/同内容幂等，不同内容错误含conflict；新runId代际严格递增。旧run的重试不能改写最新代际。

completeShard按冻结计划持久化指定分片，可由不同进程并行、重复调用，不能使用全局内存账本；pending返回未持久化的分片ID，按声明顺序。publish只允许当前最新准备代，且所有分片存在、SHA-256与计划一致，才一次原子替换可见快照；尚未齐备/过期返回false，损坏分片抛错误含corrupt且可见快照不变。归并顺序按分片声明顺序及分片内部行顺序，重复文本必须保留。resume补齐缺片后publish，可在新进程反复恢复。返回快照/输入数组与内部状态隔离。

固定磁盘协议：root/runs/<sha256(runId)>/plan.json持久化计划，分片位于同目录shards/<sha256(shardId)>.json，内容为JSON字符串数组；root/head.json保存最新准备的{generation,runId}，root/visible.json保存完整可见快照。可写唯一临时文件并原子rename，崩溃遗留.tmp不能被当作完整分片。hook(FailurePoint)在plan-written（计划写完、head更新之前）、shard-written（分片写完）、snapshot-written（可见快照写完）调用，抛异常或进程退出后持久状态必须可恢复。

prepare/publish由单一协调者串行调用，completeShard才允许多进程并行；不要求跨进程多协调者CAS，也不承诺外部副作用恰好一次。此题测试本地持久数据与原子发布，区别于API-04的租约任务队列。原EffectLedger需自身提供可靠has/apply语义，其旧模拟题不证明任意外部系统恰好一次。
