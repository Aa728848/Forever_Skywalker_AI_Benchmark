# STATE-04 · UI、服务、缓存的故障后一致性

- 难度：极度困难；题型：独立核心题；能力域：持久化与故障恢复。运行时：TypeScript on Node.js 24。题目版本：0.1.0。

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

## 限制

- 只改 `starter/`；不得引入第三方依赖；不得使用真实计时器；不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

## 判定

- 参考实现通过全部公开与未公开检查；缺陷起始版本只被声明的检出项判失败；替代实现同样通过。
- 本阶段产出检查结论与可用验证分；代码质量评审接入前总分保持待定。
