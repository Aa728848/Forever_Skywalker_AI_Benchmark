# PERF-02 · 长列表局部更新与渲染范围

- 难度：中等；题型：独立核心题；能力域：性能优化。运行时：TypeScript on Node.js 24。题目版本：0.1.0。

## 背景

`starter/src/window.ts` 为长列表计算可见窗口并在窗口内应用一次更新。当前实现**先全量复制整张列表再切片**：
列表一万行、窗口只有五行时依然要遍历一万行。请在**不改变公开接口**的前提下修复，
让访问次数与窗口大小同阶、与列表长度无关。

## 公开接口（冻结）

```ts
export interface Row { readonly id: string; readonly value: number }
export interface RenderWindow { readonly offset: number; readonly size: number }
export interface RenderedRange { readonly start: number; readonly end: number; readonly items: readonly Row[] }
export function updateRows(rows: readonly Row[], patch: Row, window: RenderWindow): RenderedRange;
```

## 必须满足的行为契约

1. 返回窗口区间 `[start, end)`（截断到列表末尾）与窗口内的行，顺序与原列表一致；`start` 越界时 `items` 为空。
2. `patch.id` 命中窗口内的行时，**该行**替换为 `{ id, value: patch.value }`；命中窗口之外或不存在时不做任何替换。
3. **复杂度**：对输入数组的元素访问次数（含 `length`）必须与 `size` 同阶（公开常数 `≤ 4×size + 8`），
   不得随列表长度增长。检查用可计数的输入观察访问次数，不依赖计时。
4. `offset` 必须是非负整数、`size` 必须是正整数，否则抛 `RangeError`。
5. 不得修改输入数组。

## 限制

- 只改 `starter/`；不得引入第三方依赖；不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

## 判定

- 参考实现通过全部公开与未公开检查；缺陷起始版本只被声明的检出项判失败；替代实现同样通过。
- 本阶段产出检查结论与可用验证分；代码质量评审接入前总分保持待定。
