# GRAPH-04 · 循环依赖图的增量失效与全量等价

- 难度：极度困难；题型：独立核心题；能力域：递归与图算法。运行时：TypeScript on Node.js 24。题目版本：0.1.0。

## 背景

`starter/src/invalidation.ts` 计算某个节点变化后需要重算的节点集合。当前实现**只失效直接依赖者**，
间接依赖与环内其它节点被漏掉，界面会继续展示过期数据。请在**不改变公开接口**的前提下修复。

## 公开接口（冻结）

```ts
export interface Node { readonly id: string; readonly deps: readonly string[] }
export class UnknownNodeError extends Error { readonly node: string }
export class Invalidator {
  constructor(nodes: readonly Node[]);
  invalidate(changed: readonly string[]): readonly string[];
}
```

## 必须满足的行为契约

1. 返回**自身 + 所有直接或间接依赖它们的节点**，去重并按 id 字典序排列（与输入顺序无关）。
2. **环**：依赖图中存在环时必须收敛（环内节点全部受影响），不得无限递归或重复入队。
3. 结果必须与对每个 changed 做朴素全量可达性计算再取并集完全一致。
4. 未知节点（含 `deps` 引用未声明节点）抛 `UnknownNodeError`。
5. 重复传入同一个 changed 节点不影响结果。

## 限制

- 只改 `starter/`；不得引入第三方依赖；不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

## 判定

- 参考实现通过全部公开与未公开检查；缺陷起始版本只被声明的检出项判失败；替代实现同样通过。
- 本阶段产出检查结论与可用验证分；代码质量评审接入前总分保持待定。
