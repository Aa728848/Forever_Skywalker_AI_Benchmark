# API-02 · 分页游标与边界

- 难度：中等；题型：独立核心题；能力域：后端与服务协议。运行时：TypeScript on Node.js 24。题目版本：0.1.0。

## 背景

`starter/src/page.ts` 用不可猜测的 base64url 游标分页。当前实现的 `decodeCursor` **不做任何校验**：
前缀不对、数字非法、写法不规范都会得到 `NaN` 或错误偏移，而不是明确的 `PageError`。请在**不改变公开接口**的前提下修复。

## 公开接口（冻结）

```ts
export interface PageRequest { readonly cursor: string | null; readonly limit: number }
export interface Page<T> { readonly items: readonly T[]; readonly nextCursor: string | null }
export class PageError extends Error { readonly field: string }
export function encodeCursor(offset: number): string;
export function decodeCursor(cursor: string): number;
export function paginate<T>(items: readonly T[], request: PageRequest): Page<T>;
```

## 必须满足的行为契约

1. 游标是 `base64url` 编码的 `offset:<非负十进制整数>`；解码必须校验前缀与数字，非法时抛 `PageError`（`field` 为 `cursor`）。
2. 只为**规范写法**的游标放行：`offset:007` 这类非规范编码必须被拒；`decodeCursor(encodeCursor(n)) === n` 必须成立。
3. `limit` 必须是 1..100 的整数，否则抛 `PageError`（`field` 为 `limit`）。
4. `cursor` 为 `null` 时从第 0 项开始；偏移超出数据范围时返回空 `items` 且 `nextCursor` 为 `null`（不是错误）。
5. `nextCursor` 仅在**还有剩余数据**时给出；恰好取完最后一页时必须为 `null`。

## 限制

- 只改 `starter/`；不得引入第三方依赖；不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

## 判定

- 参考实现通过全部公开与未公开检查；缺陷起始版本只被声明的检出项判失败；替代实现同样通过。
- 本阶段产出检查结论与可用验证分；代码质量评审接入前总分保持待定。
