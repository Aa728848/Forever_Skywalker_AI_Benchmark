# LIFE-04 · 子进程故障、回收和验收重入隔离

- 难度：极度困难；题型：独立核心题；能力域：生命周期。运行时：TypeScript on Node.js 24。题目版本：0.1.1。

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

## 真实子进程、验收上下文与快照代际（0.1.1）

保留注入式 AcceptanceRunner；另在 `starter/src/process-acceptance.ts` 修复真实进程适配。

```ts
export interface ProcessCommand { readonly command: string; readonly args: readonly string[]; readonly cwd: string; readonly timeoutMs: number }
export interface ProcessResult { readonly snapshot: string; readonly fault: 'exited' | 'crashed' | 'killed' | 'timeout'; readonly exitCode: number | null; readonly signal: string | null; readonly pid: number }
export class ProcessAcceptance {
  constructor(command: ProcessCommand);
  get busy(): boolean;
  get latest(): ProcessResult | null;
  invalidate(snapshot: string): void;
  run(snapshot: string, context?: 'development' | 'judge'): Promise<ProcessResult | null>;
}
```

- run 启动真实命令，按退出码、信号、超时返回分类；超时预算是正安全整数。启动错误原样拒绝且释放 busy，任何正常结算都解除 busy。
- judge 上下文直接返回 null，不得启动子进程，防止裁判执行再次触发自身验收。已有在途进程时 development 调用以 BusyError 拒绝。
- 每次开始验收及 invalidate 都切换快照代际并使 latest 失效。只允许对应当前快照与当前代际的结果写入 latest；旧结果仍返回给原调用者，但不能成为新快照的通过证据。
- 超时必须清理仍在运行的父进程与后代。Linux 使用独立进程组，父进程异常退出后也必须清理同组后代；Windows 本机专项验证活跃进程树回收，父进程已退出后的孤儿回收须在正式 Linux 档案验证。
- 检查真实启动 Node 父/子进程，以进程存在性和退出码验收，不能仅调用假的 kill() 记账。

## 限制

- 只改 `starter/`；不得引入第三方依赖；AcceptanceRunner 继续通过注入 ChildPort，ProcessAcceptance 使用真实子进程；
  不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

## 判定

- 参考实现通过全部公开与未公开检查；缺陷起始版本只被声明的检出项判失败；替代实现同样通过。
- 本阶段产出检查结论与可用验证分；代码质量评审接入前总分保持待定。
