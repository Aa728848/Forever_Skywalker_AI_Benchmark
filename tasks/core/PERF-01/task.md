# PERF-01 · 消除重复解析并保持结果

- 难度：简单；题型：独立核心题；能力域：性能优化。运行时：TypeScript on Node.js 24。题目版本：0.2.0。

## 背景

`starter/src/summary.ts` 把 `key=value` 行汇总成每个 key 的累加值。当前实现先收集 key，
再为**每个 key 重新全量扫描输入**，复杂度退化到 O(key 数 × 行数)。请在**不改变公开接口与结果**的前提下修复。

## 公开接口（冻结）

```ts
export interface ParsedLine { readonly key: string; readonly value: number }
export class InvalidLineError extends Error { readonly index: number }
export function parseLine(line: string, index?: number): ParsedLine;
export function summarizeRecords(lines: readonly string[]): Record<string, number>;
```

## 必须满足的行为契约

1. 合法行是 `key=value`：key 非空且不含空白与 `=`；value 是可选负号的十进制整数。
2. 非法行抛 `InvalidLineError`，`index` 指向该行在输入中的下标。
3. `summarizeRecords` 对同一 key 累加 `value`，返回普通对象；空输入返回 `{}`。
4. **复杂度**：对输入数组的元素访问总次数必须是 O(n)，公开常数 `≤ 8n`；检查用可计数的输入观察访问次数。
5. 不得修改输入；同一输入重复调用结果一致；相同内容的行不得让访问次数膨胀。

## 限制

- 只改 `starter/`；不得引入第三方依赖；不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

## 判定

- 参考实现通过全部公开与未公开检查；缺陷起始版本只被声明的检出项判失败；替代实现同样通过。
- 本阶段产出检查结论与可用验证分；代码质量评审接入前总分保持待定。

所有符合词法的键都作为数据，包括 __proto__、constructor、toString；返回对象仍使用 Object.prototype，不能改变原型或误读继承属性。
