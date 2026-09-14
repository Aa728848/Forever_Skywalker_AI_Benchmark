# ARCH-02 · Provider 元数据与运行时拆分

- 难度：中等；题型：独立核心题；能力域：耦合与解耦。运行时：TypeScript on Node.js 24。题目版本：0.2.0。

## 背景

`starter/src/providers.ts` 按运行环境拆分 provider。当前实现**不看 `runtime` 元数据**，
而是用 id 前缀 `browser-` 猜“浏览器专属”：名字带前缀的共享 provider 在 Node 侧被误删，
而真正浏览器专属但命名随意的 provider 又被 Node 侧加载。请在**不改变公开接口**的前提下修复。

## 公开接口（冻结）

```ts
export type Runtime = 'shared' | 'browser' | 'node';
export interface Provider { readonly id: string; readonly runtime: Runtime; readonly label: string }
export interface ResolvedProviders { readonly usable: readonly Provider[]; readonly skipped: readonly string[] }
export class DuplicateProviderError extends Error { readonly id: string }
export class InvalidProviderError extends Error { readonly id: string }
export function resolveProviders(catalog: readonly Provider[], runtime: 'browser' | 'node'): ResolvedProviders;
```

## 必须满足的行为契约

1. **只看元数据**：`runtime === 'shared'` 或 `runtime === 目标运行时` 的 provider 进入 `usable`，其余进入 `skipped`；
   判断不得依赖 id 的命名、前缀或顺序。
2. `usable` 保持目录中的原始相对顺序；`skipped` 同样保持目录顺序。
3. 重复 id 抛 `DuplicateProviderError`（`id` 为重复的 id）；`id` 为空串或 `runtime` 非法抛 `InvalidProviderError`。
4. 空目录返回 `{ usable: [], skipped: [] }`。

## 限制

- 只改 `starter/`；不得引入第三方依赖；不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

## 判定

- 参考实现通过全部公开与未公开检查；缺陷起始版本只被声明的检出项判失败；替代实现同样通过。
- 本阶段产出检查结论与可用验证分；代码质量评审接入前总分保持待定。

## 0.2.0 元数据目录与惰性模块加载

保留 resolveProviders，新增 starter/src/provider-registry.ts 的 ProviderRegistry(catalog:readonly LoadableProvider[])，LoadableProvider 在 Provider 上增加 load():Promise<unknown>。list(runtime) 返回仅id/runtime/label元数据副本，不能触发任何loader；构造时按原目录规则验证重复/非法元数据。

load(id,runtime) 必须先判断该provider是否属于目标运行时，再加载模块；未知/不可用id返回以RangeError拒绝的Promise，不能同步抛错或调用loader。成功结果仅在当前registry缓存；同id并发（含shared跨runtime）只调用一次loader，所有调用者获得同一结果。loader同步抛出或异步失败均原样转为Promise拒绝，失败不得永久缓存。另一个registry拥有独立生命周期。
