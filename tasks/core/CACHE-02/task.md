# CACHE-02 · 同键加载合并与失败恢复

- 难度：中等；题型：独立核心题；能力域：缓存。
- 运行时：TypeScript on Node.js 24（依赖 Node 原生类型剥离，仅可使用可擦除语法）。
- 题目版本：0.1.0；评分规则版本：0.1.0。

## 背景

`starter/` 是一个可独立运行的最小项目，`starter/src/keyed-loader.ts` 按 key 合并并发加载并缓存成功结果。
当前版本在加载失败后无法恢复：一次失败会永久影响该 key 的后续请求。请在**不改变公开接口**的前提下修复它。

## 公开接口（冻结，不得修改签名、导出名与文件路径）

文件：`starter/src/keyed-loader.ts`

```ts
export type KeyedLoaderSource<V> = (key: string) => Promise<V>;

export class KeyedLoader<V> {
  constructor(source: KeyedLoaderSource<V>);
  load(key: string): Promise<V>;
  has(key: string): boolean;
  delete(key: string): boolean;
  clear(): void;
  readonly size: number;
}
```

## 必须满足的行为契约

1. **缓存命中**：若该 key 已有已缓存值，`load(key)` 返回以该值兑现的 Promise，且不得调用 `source`。
2. **同键合并**：若该 key 已有在途加载，`load(key)` 必须加入该次加载，不得再次调用 `source`；同一次加载的所有调用者成功时得到同一个值引用（`Object.is` 相等）。
3. **启动**：若既无缓存值也无在途加载，`load(key)` 必须恰好调用一次 `source(key)`，且该调用必须在 `load` 返回之前发生（同步调用，不得推迟到后续宏任务）。
4. **成功**：`source` 兑现后，值写入缓存；该 key 不再有在途记录；已缓存值保留到 `delete`/`clear`（本题不包含 TTL 与容量淘汰）。
5. **失败传播**：`source` 返回的 Promise 被拒绝时，本次加载的所有调用者必须以**同一个错误对象**（`Object.is` 相等）被拒绝。
6. **失败恢复**：失败结算后，该 key 不得留下缓存值或在途记录；下一次 `load(key)` 必须重新调用 `source`。被拒绝的 Promise 不得被永久复用。
7. **同步抛出**：若 `source(key)` 同步抛出，`load` 不得同步抛出，必须返回以该错误拒绝的 Promise。此情形视为本次加载未建立，不产生可合并的在途记录。
8. **键身份**：键为字符串，按 `Map` 的 SameValueZero 语义比较；`'Key'` 与 `'key'` 是不同键。
9. **并行**：不同 key 的加载互不阻塞。为 key A 发起的在途加载不得延迟 key B 的 `source` 调用：在同一同步轮次内调用 `load('a')` 与 `load('b')` 时，`source` 必须已被调用两次。不得为避免竞争把所有加载串行化。
10. **缓存 API**：`has`/`delete`/`size`/`clear` 只作用于已缓存值，不计数也不影响在途加载；`delete` 返回是否移除了值；在途加载在结算后仍会写入缓存（即使结算前调用过 `delete` 或 `clear`）；`clear()` 移除全部已缓存值。

## 限制

- 答案范围限于 `starter/`；不要修改 `public-tests/`。
- 不得引入第三方运行时依赖、网络访问、定时器或本题未声明的能力（TTL、容量淘汰、持久化等）。
- 只能使用可擦除的 TypeScript 语法：不得使用 `enum`、`namespace`、构造函数参数属性等 Node 类型剥离无法处理的写法。

## 公开检查

`public-tests/` 随工作区发布。在**工作区根目录**运行：

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

公开检查只覆盖上述契约的一部分。正式判定会在冻结快照上追加未公开的边界值、调用排列与错误路径检查；这些检查的要求同样来自本文件，不引入新需求。

## 判定

- 参考实现通过全部公开与未公开检查。
- 注入目标缺陷的起始版本必须被检出（失败项限于预先声明的检出项），其余已正确行为不得回归。
- 与参考实现结构不同的替代实现也必须通过同一契约。
- 候选项只被检查检出或不被检出；本阶段不产出正式分数，总分在代码质量评审接入前保持待定。
