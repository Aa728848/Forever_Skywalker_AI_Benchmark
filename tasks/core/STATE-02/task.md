# STATE-02 · 状态迁移与旧版本契约

- 难度：中等；题型：独立核心题；能力域：持久化与故障恢复。运行时：TypeScript on Node.js 24。题目版本：0.1.0。

## 背景

`starter/src/snapshot.ts` 把历史快照迁移到当前格式。v1 用 `status` 字段且状态名不同（`new`/`active`/`done`），
v2 用 `state`。当前实现**不看版本**：v1 快照被当成 v2 处理（缺少 `state` 就报结构错误），
未知版本也被照单全收。请在**不改变公开接口**的前提下修复。

## 公开接口（冻结）

```ts
export type OrderState = 'draft' | 'placed' | 'paid' | 'shipped' | 'cancelled';
export interface Snapshot { readonly version: 2; readonly state: OrderState }
export class InvalidSnapshotError extends Error {}
export class UnsupportedVersionError extends Error { readonly version: string }
export class UnknownStateError extends Error { readonly state: string }
export const orderStates: readonly OrderState[];
export function migrate(raw: unknown): Snapshot;
```

## 必须满足的行为契约

1. `version === 2`：`state` 必须是合法状态名，否则抛 `InvalidSnapshotError`；合法时原样返回（`{ version: 2, state }`）。
2. `version === 1`：按**冻结映射**转换旧状态名——`new → draft`、`active → placed`、`done → shipped`；
   缺 `status` 抛 `InvalidSnapshotError`；映射表里没有的旧名抛 `UnknownStateError`（`state` 为旧名）。
3. 其它版本（含缺少 `version`）抛 `UnsupportedVersionError`，`version` 为 `String(原始值)`（缺省时是 `'undefined'`）。
4. 非对象输入抛 `InvalidSnapshotError`。
5. 迁移必须幂等：`migrate(migrate(x))` 与 `migrate(x)` 相同。

## 限制

- 只改 `starter/`；不得引入第三方依赖；不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

## 判定

- 参考实现通过全部公开与未公开检查；缺陷起始版本只被声明的检出项判失败；替代实现同样通过。
- 本阶段产出检查结论与可用验证分；代码质量评审接入前总分保持待定。
