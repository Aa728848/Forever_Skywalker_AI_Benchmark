# GRAPH-02 · 图去重、环与确定性排序

- 难度：中等；题型：独立核心题；能力域：递归与图算法。运行时：TypeScript on Node.js 24。题目版本：0.1.0。

## 背景

`starter/src/graph.ts` 做拓扑排序。当前实现**不规范化输入**：重复边被重复计入度、后继按输入顺序排列、
起始层也按输入顺序取，于是同一张图在不同输入顺序下会给出不同答案，重复边甚至会让入度永远降不到 0。
请在**不改变公开接口**的前提下修复；环检测与未知节点的错误类型保持不变。

## 公开接口（冻结）

```ts
export interface Edge { readonly from: string; readonly to: string }
export class CycleError extends Error { readonly path: readonly string[] }
export class UnknownNodeError extends Error { readonly node: string }
export function topologicalOrder(nodes: readonly string[], edges: readonly Edge[]): readonly string[];
```

## 必须满足的行为契约

1. **去重**：重复节点只算一个；同一条边出现多次只算一次入度。
2. **确定性**：结果必须与输入顺序无关——同一张图的任何输入排列都给出同一个序列；
   可选的节点之间按**字典序**选取（等价于 Kahn 算法里始终取最小的可用节点）。
3. **环检测**：存在环时抛 `CycleError`，`path` 是环上的节点序列，首尾必须是同一个节点且长度 ≥3；
   环的发现结果也必须与输入顺序无关。
4. **未知节点**：边引用了未在 `nodes` 中声明的节点时抛 `UnknownNodeError`（`node` 为该节点）。
5. 空图返回空数组；只有一个节点时返回该节点。

## 限制

- 只改 `starter/`；不得引入第三方依赖；不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

## 判定

- 参考实现通过全部公开与未公开检查；缺陷起始版本只被声明的检出项判失败；替代实现同样通过。
- 本阶段产出检查结论与可用验证分；代码质量评审接入前总分保持待定。
