# CACHE-03 · 失效期间的在途旧结果

- 难度：困难；题型：独立核心题；能力域：缓存。运行时：TypeScript on Node.js 24。题目版本：0.1.0。

## 背景

`starter/src/cache.ts` 做带版本号的读取缓存。写入或删除之后调用 `invalidate(key)` 让缓存失效。
当前实现**无条件把在途结果写回缓存**：请求刚发出就被失效时，旧结果会重新占据缓存，
于是界面在“已更新”之后又跳回旧数据。请在**不改变公开接口**的前提下修复。

## 公开接口（冻结）

```ts
export interface CachePort { load(key: string): Promise<string> }
export class StaleWriteError extends Error { readonly key: string }
export class VersionedCache {
  constructor(port: CachePort);
  version(key: string): number;
  invalidate(key: string): void;
  get(key: string): Promise<string>;
}
```

## 必须满足的行为契约

1. `get` 未命中时调用一次 `port.load(key)` 并把结果用作缓存；命中时**不得**再次 `load`，直接返回同一个 promise。
2. `invalidate(key)` 推进该 key 的版本（从 0 开始，每次 +1）并立即淘汰缓存；之后必然重新 `load`。
3. **在途结果不得复活缓存**：若 `get` 发起后、结算前该 key 发生过 `invalidate`，
   则该次结果**不得**留在缓存里；但**必须原样返回**给这次调用方（它请求的是当时的数据）。
4. 版本判定以**发起时的版本**为准：期间发生多次失效时，只有最后发起的那次请求会占据缓存。
5. 不同 key 互不影响（各自的版本与缓存独立）。

## 限制

- 只改 `starter/`；不得引入第三方依赖；不得使用真实计时器；不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

## 判定

- 参考实现通过全部公开与未公开检查；缺陷起始版本只被声明的检出项判失败；替代实现同样通过。
- 本阶段产出检查结论与可用验证分；代码质量评审接入前总分保持待定。
