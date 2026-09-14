# GRAPH-01 · 树遍历终止与叶节点

- 难度：简单；题型：独立核心题；能力域：递归与图算法。运行时：TypeScript on Node.js 24。题目版本：0.1.0。

## 背景

`starter/src/tree.ts` 前序遍历树并收集叶子。当前实现用**全局集合**去重（循环被静默跳过、共享节点漏访问），
把“缺省 children”的节点漏出叶子，并且从不检查节点上限。请在**不改变公开接口**的前提下修复。

## 公开接口（冻结）

```ts
export interface TreeNode { readonly id: string; readonly children?: readonly TreeNode[] }
export interface WalkResult { readonly visited: readonly string[]; readonly leaves: readonly string[] }
export class NodeLimitExceededError extends Error { readonly limit: number }
export class InvalidTreeError extends Error { readonly path: string }
export function walkTree(root: TreeNode, options?: { maxNodes?: number }): WalkResult;
```

## 必须满足的行为契约

1. 前序遍历：先父后子，子节点按 `children` 顺序；每个**出现位置**恰好访问一次（同一对象出现在不同分支要各访问一次）。
2. `leaves` 是没有任何子节点的节点 id：`children` 缺省与空数组等价，二者都算叶子；顺序与 `visited` 一致。
3. `maxNodes` 缺省 10000，必须是 ≥1 的整数；一旦将要访问的节点数超过上限，抛 `NodeLimitExceededError`（`limit` 等于上限），不得返回部分结果。
4. 非法结构抛 `InvalidTreeError`，`path` 指向出错位置：根非法为 `root`，`children` 非数组为 `该节点路径 + '.children'`，子项非法或 `id` 非字符串为 `该节点路径` 或 `该节点路径 + '.children[i]'`。
5. 同一个节点对象出现在**自己的后代**中（循环）必须抛 `InvalidTreeError`，`path` 指向重复出现的位置；不同分支共享同一对象是合法的。
6. 不修改输入；重复调用结果一致。

## 限制

- 只改 `starter/`；不得引入第三方依赖；不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

## 判定

- 参考实现通过全部公开与未公开检查；缺陷起始版本只被声明的检出项判失败；替代实现同样通过。
- 本阶段产出检查结论与可用验证分；代码质量评审接入前总分保持待定。
