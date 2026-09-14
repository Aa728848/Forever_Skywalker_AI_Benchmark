# GRAPH-03 · 深层 AST 遍历与栈安全

- 难度：困难；题型：独立核心题；能力域：递归与图算法。
- 运行时：TypeScript on Node.js 24（依赖 Node 原生类型剥离，仅可使用可擦除语法）。
- 题目版本：0.1.0；评分规则版本：0.1.0。

## 背景

`starter/` 是一个可独立运行的最小项目，`starter/src/ast.ts` 提供 AST 遍历与深度查询。
当前实现用朴素递归，遇到深层输入会栈溢出，`maxDepth` 也不遵守 `limit`。
请在**不改变公开接口**的前提下修复，使深层输入下的行为满足下列契约。

## 公开接口（冻结，不得修改签名、导出名与文件路径）

```ts
export interface AstNode { readonly type: string; readonly children?: readonly AstNode[] }
export class DepthExceededError extends Error { readonly limit: number }
export class InvalidNodeError extends Error { readonly path: string }
export function walkPostOrder(root: AstNode, visit: (node: AstNode) => void): number;
export function flattenPreOrder(root: AstNode): string[];
export function maxDepth(root: AstNode, limit: number): number;
```

## 必须满足的行为契约

1. `walkPostOrder` 后序访问每个节点恰好一次并返回访问数量：先子后父，子节点按 `children` 顺序、兄弟按索引升序。
2. 深度 **200000** 的链式输入必须正常完成，不得抛出 RangeError 或 "Maximum call stack size exceeded"。
3. `maxDepth` 返回真实深度（根为 1）；一旦超过 `limit` 必须抛 `DepthExceededError`，其 `limit` 属性等于传入值；`limit` 必须是 ≥1 的整数。
4. 畸形输入必须抛 `InvalidNodeError`：`children` 不是数组时 `path` 为 `该节点路径 + '.children'`，子项不是合法节点时 `path` 为 `该节点路径 + '.children[索引]'`，根非法时 `path` 为 `'root'`；路径从根记为 `root`。
5. 合法节点是「对象且 `type` 是非空字符串」；缺省 `children` 与空数组等价。
6. 同一棵树多次遍历结果一致；遍历与深度查询都不得修改输入。
7. 不得为修复深层输入而改变节点含义、跳过节点或提前返回。

## 限制

- 答案范围限于 `starter/`；不要修改 `public-tests/`。
- 不得引入第三方运行时依赖。
- 只能使用可擦除的 TypeScript 语法：不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

在**工作区根目录**运行：

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

公开检查只覆盖契约的一部分；正式判定还会在冻结快照上追加未公开的输入规模与结构组合，
它们的要求同样来自本文件，不引入新需求。

## 判定

- 参考实现通过全部公开与未公开检查。
- 注入目标缺陷的起始版本必须被检出（失败项限于预先声明的检出项），其余已正确行为不得回归。
- 与参考实现结构不同的替代实现也必须通过同一契约。
- 本阶段只产出检查通过或失败；代码质量评审接入前总分保持待定。
