# API-01 · 请求校验与错误契约

- 难度：简单；题型：独立核心题；能力域：后端与服务协议。
- 运行时：TypeScript on Node.js 24（仅可擦除语法）。题目版本：0.1.0。

## 背景

`starter/src/request.ts` 校验下单请求。当前实现只报第一个问题、静默忽略未知字段、把数字字符串隐式转换，
并且数量下界写成 `0`。请在**不改变公开接口**的前提下修复。

## 公开接口（冻结）

```ts
export interface OrderRequest { readonly orderId: string; readonly quantity: number; readonly note?: string }
export interface ValidationIssue { readonly field: string; readonly code: 'missing' | 'type' | 'range' | 'unknown-field' }
export class RequestError extends Error { readonly status: number; readonly issues: ValidationIssue[] }
export function validateOrderRequest(payload: unknown): OrderRequest;
```

## 必须满足的行为契约

1. 载荷必须是普通对象；否则抛 `RequestError`，`issues` 只有一项 `{ field: '', code: 'type' }`，`status` 为 400。
2. 未知字段一律报 `unknown-field`（不得静默丢弃）。
3. `orderId` 必填且为非空字符串；缺失报 `missing`，类型错报 `type`。
4. `quantity` 必填且为 1..1000 的**整数**；缺失 `missing`、非数字或非整数（含数字字符串 `"5"`）报 `type`、越界报 `range`。
5. `note` 可选；提供时必须是非空字符串且长度 ≤ 200，否则报 `type`。
6. 一次返回**全部**问题，顺序稳定：先未知字段（按字段名升序出现顺序），再 orderId、quantity、note。
7. 校验通过时返回冻结的结果对象，且不是调用方传入的那个对象。

## 限制

- 只改 `starter/`；不得引入第三方依赖；不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

## 判定

- 参考实现通过全部公开与未公开检查；缺陷起始版本只被声明的检出项判失败；替代实现同样通过。
- 本阶段产出检查结论与可用验证分；代码质量评审接入前总分保持待定。
