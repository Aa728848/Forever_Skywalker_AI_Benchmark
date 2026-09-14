# PERF-02 · 长列表局部更新与渲染范围

- 难度：中等；题型：独立核心题；能力域：性能优化。运行时：TypeScript on Node.js 24 + Chromium 浏览器。题目版本：0.2.0。

## 背景

`starter/src/window.ts` 为长列表计算可见窗口并在窗口内应用一次更新。当前实现**先全量复制整张列表再切片**：
列表一万行、窗口只有五行时依然要遍历一万行。请在**不改变公开接口**的前提下修复，
让访问次数与窗口大小同阶、与列表长度无关。`mountList` 还会在每次局部更新时重建所有可见 DOM，导致其他行失去节点身份与焦点；需要一并修复。

## 公开接口（冻结）

```ts
export interface Row { readonly id: string; readonly value: number }
export interface RenderWindow { readonly offset: number; readonly size: number }
export interface RenderedRange { readonly start: number; readonly end: number; readonly items: readonly Row[] }
export function updateRows(rows: readonly Row[], patch: Row, window: RenderWindow): RenderedRange;
export interface MountedList {
  applyPatch(patch: Row): void;
  setWindow(window: RenderWindow): void;
  dispose(): void;
}
export function mountList(container: HTMLElement, rows: readonly Row[], initialWindow: RenderWindow): MountedList;
```

## 必须满足的行为契约

1. 返回窗口区间 `[start, end)`（截断到列表末尾）与窗口内的行，顺序与原列表一致；`start` 越界时 `items` 为空。
2. `patch.id` 命中窗口内的行时，**该行**替换为 `{ id, value: patch.value }`；命中窗口之外或不存在时不做任何替换。
3. **复杂度**：对输入数组的元素访问次数（含 `length`）必须与 `size` 同阶（公开常数 `≤ 4×size + 8`），
   不得随列表长度增长。检查用可计数的输入观察访问次数，不依赖计时。
4. `offset` 必须是非负整数、`size` 必须是正整数，否则抛 `RangeError`。
5. 不得修改输入数组。

## 浏览器 DOM 契约（0.2.0 新增）

1. `mountList` 独占传入容器，设置 `role="list"`；只挂载当前窗口，每行一个 `role="listitem"` 元素，带 `data-row-id`，内含原生按钮。按钮的 `data-row-id` 为该行 ID，显示文本为 `${id}: ${value}`。行 ID 唯一，可以为空串、Unicode 或 HTML 字符，必须按文本显示。
2. `applyPatch` 只更新可见窗口内命中的行，窗口外/不存在 ID 不改变 DOM。相同值不产生 DOM mutation；不同值只更新该行文本，保留所有行元素和按钮的身份以及未更新行的焦点。
3. 点击行内按钮把该行当前值加一。已应用的更新在后续窗口切换回来时仍保留，但不得写回原数组。
4. `setWindow` 遵循相同的整数和范围规则，窗口外的 DOM 移除，新进入的行挂载，重叠行复用原元素。错误窗口抛 `RangeError`，当前窗口与 DOM 不变。
5. `dispose` 清空容器，移除所安装的事件监听并释放实例持有的状态；重复调用无害。销毁后 `applyPatch`、`setWindow` 抛错，不重新挂载节点。

DOM 与交互必须在真实 Chromium 浏览器中成立；Node 内的伪造 DOM 不算通过。公开和隐藏检查都实际启动浏览器，使用节点身份、焦点、MutationObserver 与点击事件验证局部更新。

## 限制

- 只改 `starter/`；不得引入第三方依赖；不得使用 `enum`、`namespace`、构造函数参数属性。
- 检查环境预装 Chromium；本机可以设置 `BENCH_BROWSER_EXECUTABLE` 指向 Chromium、Chrome 或 Edge。候选模块必须能被原生类型剥离后作为浏览器 ES module 执行。
- 性能工作负载另测 80,000 行、20 行窗口下 4,000 次不同位置更新；正确性先通过，再同环境预热至少 2 轮、参考/候选交替至少 7 对。访问次数限制仍属于功能最低资源验收，计时比值属于独立质量证据，未经校准不生成发布级正式成绩。

## 公开检查

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

## 判定

- 参考实现通过全部公开与未公开检查；缺陷起始版本只被声明的检出项判失败；替代实现同样通过。
- 本阶段产出检查结论与可用验证分；代码质量评审接入前总分保持待定。
