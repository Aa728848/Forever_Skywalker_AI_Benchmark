# STATE-04 · UI、服务、缓存的故障后一致性

- 难度：极度困难；题型：独立核心题；能力域：持久化与故障恢复。运行时：TypeScript on Node.js 24。题目版本：0.1.1。

## 背景

`starter/src/consistency.ts` 把一次提交依次落到服务层、缓存层与界面层。当前实现的失败路径**只回滚出错的那一层**：
之前已经应用成功的层留在半成品状态，于是界面显示新值、缓存还是旧值、服务已经写入——三层长期不一致。
请在**不改变公开接口**的前提下修复。

## 公开接口（冻结）

```ts
export interface Layer { readonly name: string; apply(value: string): void; revert(value: string): void; has(value: string): boolean }
export interface Layers { readonly service: Layer; readonly cache: Layer; readonly ui: Layer }
export class CommitError extends Error { readonly layer: string }
export class Coordinator {
  constructor(layers: Layers);
  get applied(): readonly string[];
  commit(value: string): Promise<string>;
}
```

## 必须满足的行为契约

1. 提交按固定顺序应用：`service → cache → ui`；成功时三层都包含该值，并记入 `applied`。
2. 任一层 `apply` 抛错时，**必须按相反顺序回滚所有已经应用成功的层**（`revert`），并以 `CommitError`（`layer` 为出错层名）拒绝。
3. 失败之后三层状态必须一致：都不包含该值，`applied` 不变。
4. 重复提交同一个值是幂等的：不重复 `apply`。
5. 回滚只针对本次提交**已经应用**的层，不得回滚未应用过的层。

## 持久化重启与通知收敛（0.1.1）

保留 Coordinator 的同步层接口；另在 `starter/src/durable-coordinator.ts` 修复持久化服务与缓存/界面投影的重启一致性。

```ts
export type CrashPoint = 'before-commit' | 'after-commit' | 'after-cache' | 'after-ui';
export interface View { readonly revision: number; readonly values: readonly string[] }
export interface Views { readonly service: View; readonly cache: View; readonly ui: View }
export class DurableConflictError extends Error {}
export class DurableCoordinator {
  constructor(directory: string, checkpoint?: (point: CrashPoint) => void);
  snapshot(): Views;
  recover(): Views;
  notify(revision: number): Views;
  commit(key: string, value: string): Promise<View>;
}
```

- 服务事务是持久事实，缓存和界面是可重建投影。成功提交 revision 递增一次；相同键/相同值重试不能增加交易，不同值抛 DurableConflictError。
- checkpoint 在所示边界调用，可以抛异常或使真实子进程退出。before-commit 失败不能留下事务；after-commit 及之后的中断不能丢失已提交事务。
- 新实例打开同一目录时必须恢复最新服务事实，并重建落后或丢失的缓存/界面投影，使三者的 revision 与 values 一致。
- notify 只接收 0 到当前服务 revision 的安全整数；非法版本抛 RangeError。重复或迟到通知须与最新服务状态收敛，不得重新执行交易或回退界面。
- 目录由调用方提供；存储格式由实现选择，只允许单进程写入。验收包括真实文件与进程退出，不要求模拟机器断电或多主数据库。

## 限制

- 只改 `starter/`；不得引入第三方依赖；不得使用真实计时器；不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

## 判定

- 参考实现通过全部公开与未公开检查；缺陷起始版本只被声明的检出项判失败；替代实现同样通过。
- 本阶段产出检查结论与可用验证分；代码质量评审接入前总分保持待定。
