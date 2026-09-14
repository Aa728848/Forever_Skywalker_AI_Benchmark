# CACHE-01 · TTL 与有界淘汰

- 难度：简单；题型：独立核心题；能力域：缓存。
- 运行时：TypeScript on Node.js 24（依赖 Node 原生类型剥离，仅可使用可擦除语法）。
- 题目版本：0.1.0；评分规则版本：0.1.0。

## 背景

`starter/` 是一个可独立运行的最小项目，`starter/src/ttl-cache.ts` 实现带 TTL 的有界缓存。
当前实现在过期边界与零值 TTL 上判断错误，逐出顺序也不是最近最少使用。请在**不改变公开接口**的前提下修复。

## 公开接口（冻结，不得修改签名、导出名与文件路径）

```ts
export interface CacheOptions { readonly ttlMs?: number; readonly now?: () => number }
export interface EntryOptions { readonly ttlMs?: number }
export class TtlCache<V> {
  constructor(capacity: number, options?: CacheOptions);
  get size(): number;
  has(key: string): boolean;
  get(key: string): V | undefined;
  set(key: string, value: V, options?: EntryOptions): void;
  delete(key: string): boolean;
  clear(): void;
}
```

## 必须满足的行为契约

1. 容量必须是 ≥1 的整数，否则构造抛 `RangeError`。
2. 条目数超过容量时逐出**最久未使用**的键；`get` 命中必须刷新该键的最近使用顺序，`has` 不刷新。
3. 同键 `set` 覆盖：条目数不增加，也不得逐出其他键。
4. TTL 语义：`set` 时 `ttlMs` 覆盖默认 TTL；缺省时用构造参数给的默认 TTL；两者都没有则永不过期。
5. 过期边界是 `now >= expiresAt`（`expiresAt = 写入时刻 + ttlMs`）：恰好到期的时刻即视为过期。
6. `ttlMs = 0` 表示立即过期，**不得**被当成“没有 TTL”；负的 `ttlMs` 抛 `RangeError`。
7. `size`、`has`、`get` 都不得把已过期条目算作存在；过期条目可以被惰性清理。
8. `delete` 返回是否删除了条目；`clear` 清空全部条目。

## 限制

- 答案范围限于 `starter/`；不要修改 `public-tests/`。
- 不得引入第三方运行时依赖；时间必须通过注入的 `now` 读取，不得直接读真实时钟以外的时间源。
- 只能使用可擦除的 TypeScript 语法：不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

在**工作区根目录**运行：

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

## 判定

- 参考实现通过全部公开与未公开检查。
- 注入目标缺陷的起始版本必须被检出（失败项限于预先声明的检出项），其余已正确行为不得回归。
- 与参考实现结构不同的替代实现也必须通过同一契约。
- 本阶段只产出检查通过或失败与可用验证分；代码质量评审接入前总分保持待定。
