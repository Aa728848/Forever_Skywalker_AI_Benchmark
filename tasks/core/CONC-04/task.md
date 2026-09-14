# CONC-04 · 断点续跑、重复事件和副作用去重

- 难度：极度困难；题型：独立核心题；能力域：异步并发。
- 运行时：TypeScript on Node.js 24（依赖 Node 原生类型剥离，仅可使用可擦除语法）。
- 题目版本：0.1.0；评分规则版本：0.1.0。

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
