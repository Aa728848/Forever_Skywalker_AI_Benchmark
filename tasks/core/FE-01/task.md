# FE-01 · 状态与错误恢复

- 难度：简单；题型：独立核心题；能力域：前端交互。
- 运行时：TypeScript on Node.js 24（依赖 Node 原生类型剥离，仅可使用可擦除语法）。
- 题目版本：0.2.0（相对 0.1.0 的设计调整：本阶段冻结列表控制器契约，浏览器级操作确认留在 Windows/浏览器专项）；评分规则版本：0.1.0。

## 背景

`starter/` 是一个可独立运行的最小项目，`starter/src/feed.ts` 维护一个分页列表的状态与视图通道。
当前实现在「分页重叠」时会重复追加条目，并且加载失败后不会恢复 busy 状态，导致后续请求永久失效。
请在**不改变公开接口**的前提下修复。

## 公开接口（冻结，不得修改签名、导出名与文件路径）

```ts
export interface FeedItem { readonly id: string; readonly text: string }
export interface FeedPage { readonly items: readonly FeedItem[]; readonly cursor: string | null }
export interface FeedView {
  render(items: readonly FeedItem[]): void;
  setBusy(busy: boolean): void;
  setError(message: string | null): void;
}
export class FeedController {
  constructor(load: (cursor: string | null) => Promise<FeedPage>, view: FeedView);
  get items(): readonly FeedItem[];
  get busy(): boolean;
  get error(): string | null;
  loadMore(): Promise<void>;
  retry(): Promise<void>;
}
```

## 必须满足的行为契约

1. 构造后 `items` 为空、`busy` 为 false、`error` 为 null。
2. `loadMore()` 进入时 `busy` 为 true 并调用 `view.setBusy(true)`；**无论成功还是失败**，结算后 `busy` 为 false 且 `view.setBusy(false)` 已被调用。
3. 成功时按 `id` 去重后追加：已存在的 id 保留原项、不重复、不重排、不改变已有项顺序；`cursor` 更新为该页的 `cursor`；`error` 清空；`view.render` 收到当前条目的快照（调用方修改该快照不得影响控制器状态）。
4. 失败时 `error` 为错误消息（非空字符串）并调用 `view.setError(消息)`；`items` 与 `cursor` 都保持不变（失败的分页不得推进游标）。
5. `retry()` 重新加载最近一次失败的分页；没有失败时等同 `loadMore()`。重试成功后 `items` 中每个 id 只出现一次。
6. 并发保护：`busy` 期间调用 `loadMore()` 或 `retry()` 不发起第二次加载，直接返回（不得抛错）。
7. 每次状态变化都通过 `view` 反映；`items` 的读取返回副本。
8. 分页可能重叠（同一 id 出现在多页），必须按 id 去重；不同控制器实例互不影响。

## 限制

- 答案范围限于 `starter/`；不要修改 `public-tests/`。
- 不得引入第三方运行时依赖、定时器或全局状态。
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
- 本阶段只产出检查通过或失败；代码质量评审接入前总分保持待定。
