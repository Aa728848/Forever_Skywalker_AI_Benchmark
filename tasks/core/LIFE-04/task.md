# LIFE-04 · 子进程故障、回收和验收重入隔离

- 难度：极度困难；题型：独立核心题；能力域：生命周期。运行时：TypeScript on Node.js 24。题目版本：0.1.0。

## 背景

`starter/src/acceptance.ts` 用子进程执行一次验收。当前实现**不隔离重入**：
已有验收在途时再次调用 `accept()` 会直接启动第二个子进程，两个验收互相踩（资源竞争、结果串台、回收混乱）。
请在**不改变公开接口**的前提下修复。

## 公开接口（冻结）

```ts
export interface ChildHandle { readonly pid: number; kill(): void; onExit(listener: (code: number | null, signal: string | null) => void): void }
export interface ChildPort { spawn(): ChildHandle }
export type Fault = 'exited' | 'crashed' | 'killed';
export interface AcceptanceResult { readonly fault: Fault; readonly signal: string | null }
export class BusyError extends Error {}
export function classify(code: number | null, signal: string | null): Fault;
export class AcceptanceRunner {
  constructor(port: ChildPort);
  get busy(): boolean;
  get reaped(): readonly number[];
  accept(): Promise<AcceptanceResult>;
}
```

## 必须满足的行为契约

1. `accept()` 启动一个子进程；退出时按 `classify` 分类：`code === 0` 为 `exited`，非零/null 为 `crashed`，带 signal 为 `killed`。
2. **回收**：无论哪类结束，子进程都必须被回收并记入 `reaped`（pid 顺序与启动顺序一致）；故障与信号终止还要调用 `kill()`。
3. **重入隔离**：已有验收在途（`busy` 为 true）时再次调用 `accept()` 必须**拒绝**并抛 `BusyError`，
   不得启动第二个子进程。
4. 验收完成后 `busy` 为 false，可以再次 `accept()`。
5. 信号信息必须原样保留在结果里，不得丢弃。

## 限制

- 只改 `starter/`；不得引入第三方依赖；不得启动真实子进程（一切通过注入的 `ChildPort`）；
  不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

## 判定

- 参考实现通过全部公开与未公开检查；缺陷起始版本只被声明的检出项判失败；替代实现同样通过。
- 本阶段产出检查结论与可用验证分；代码质量评审接入前总分保持待定。
