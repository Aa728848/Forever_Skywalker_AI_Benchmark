# LIFE-03 · 启动、停止和重启竞争

- 难度：困难；题型：独立核心题；能力域：生命周期。运行时：TypeScript on Node.js 24。题目版本：0.2.0。

## 背景

`starter/src/supervisor.ts` 管理一个需要长期运行的 runner。当前实现有一处危险的竞争：
**停止尚未完成时调用 `start()`**，它会立即启动新的 runner，并且复用已经被 abort 的 controller——
于是新旧 runner 并发运行，新 runner 拿到的是一个已经中止的 signal，起来就立刻退出。
请在**不改变公开接口**的前提下修复。

## 公开接口（冻结）

```ts
export interface Runner { run(signal: AbortSignal): Promise<void> }
export type Phase = 'idle' | 'starting' | 'running' | 'stopping';
export class Supervisor {
  constructor(runner: Runner);
  get phase(): Phase;
  get startCount(): number;
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

## 必须满足的行为契约

1. `start()` 在 `idle` 时启动 runner 并把 `phase` 置为 `running`，`startCount` 加一；已在 `starting`/`running` 时幂等（不重复调用 runner）。
2. `stop()` 中止当前 signal、等待 runner 结算后回到 `idle`；重复调用幂等且共用同一次停止过程。
3. **重启竞争**：`stop()` 尚未完成时调用 `start()` 必须等停止完成后再启动（不得与旧 runner 并发），
   且这次启动**不得被丢弃**（`startCount` 最终加一）；新 runner 必须拿到**全新的、未中止的** signal。
4. `phase` 在任一时刻只能是 `idle`/`starting`/`running`/`stopping` 之一，且与上述语义一致。

## 限制

- 只改 `starter/`；不得引入第三方依赖；不得使用真实计时器；不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

## 判定

- 参考实现通过全部公开与未公开检查；缺陷起始版本只被声明的检出项判失败；替代实现同样通过。
- 本阶段产出检查结论与可用验证分；代码质量评审接入前总分保持待定。

## 0.2.0 运行代际与实际结束

runner.run 可同步抛错，或之后正常/异常结算。同步抛错必须使 start 以同一错误拒绝并回到 idle；startCount 统计实际 run 调用次数（含失败启动）。已成功启动的运行正常或异常结束都释放该代际并回到 idle；异步运行异常不回头改变已结算的 start，stop 仍可完成。

停止屏障未结算时，任意多个 start 等待同一旧代际结束，合并成一次新启动；不能与旧runner同时运行、复用其signal、或让旧代际的结算清除新状态。stop等待真实运行promise结算，不能仅根据abort信号当作资源已释放。检查使用显式Promise屏障，无真实定时器。
