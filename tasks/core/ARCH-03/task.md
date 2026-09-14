# ARCH-03 · 替换适配器并保持公共契约

- 难度：困难；题型：独立核心题；能力域：耦合与解耦。运行时：TypeScript on Node.js 24。题目版本：0.2.0。

## 背景

`starter/src/repository.ts` 对外暴露稳定的读取契约，背后可能接旧适配器（同步、毫秒、可选 payload）
或新适配器（异步、秒、`status: 'ok' | 'missing'`）。当前实现**直接把新适配器的字段透传**：
秒被当成毫秒、`missing` 被当成成功、适配器异常也不包装，调用方拿到的是看起来一样、其实单位不同的结果。
请在**不改变公开接口**的前提下修复。

## 公开接口（冻结）

```ts
export interface LegacyAdapter { fetch(id: string): LegacyResult }
export interface AdapterV2 { load(id: string): Promise<V2Result> }
export interface ReadResult { readonly ok: boolean; readonly durationMs: number; readonly body: string | null }
export class AdapterError extends Error { readonly id: string }
export class Repository { constructor(adapter: LegacyAdapter | AdapterV2); read(id: string): Promise<ReadResult> }
```

## 必须满足的行为契约

1. 无论背后是哪个适配器，`ReadResult` 语义一致：`ok` 取旧适配器的 `ok` / 新适配器的 `status === 'ok'`；
   `durationMs` 取旧适配器的 `ms` / 新适配器的 `durationSeconds × 1000`；`body` 取 `payload ?? null` / `body`。
2. 新适配器返回 `missing` 时 `ok` 为 false、`body` 为 `null`，**不是错误**。
3. 适配器抛错（同步或异步）统一抛 `AdapterError`（`id` 为请求的 id），不得泄漏原始错误。
4. 不得修改适配器对象，也不得向调用方暴露适配器内部字段。

## 限制

- 只改 `starter/`；不得引入第三方依赖；不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

## 判定

- 参考实现通过全部公开与未公开检查；缺陷起始版本只被声明的检出项判失败；替代实现同样通过。
- 本阶段产出检查结论与可用验证分；代码质量评审接入前总分保持待定。

## 0.2.0 适配器热替换、合并读取与调用方取消

保留 Repository，在 starter/src/repository-router.ts 实现 RepositoryRouter(adapter:CancellableAdapter)，CancellableAdapter.load(id,signal):Promise<V2Result>。公开 read(id,signal?):Promise<ReadResult> 和 replace(adapter):void。

相同当前适配器代际与id的在途请求只调用一次load，完成后不缓存结果。不同调用方取消互不影响：该调用者以ReadCancelledError拒绝；最后一个读者离开才abort底层请求并立即移除合并身份。已abort的signal不得发起load。

replace同步切换代际，中止旧底层signal并让旧等待者以AdapterReplacedError拒绝。旧适配器即使忽略取消并迟到完成，也不能影响新代相同id的等待者/合并记录。load可以同步重入replace，此时也须隔离旧请求。普通load同步/异步故障按原Repository规则包装AdapterError；正常结果保持秒转毫秒、missing正文归null的契约。无真实定时器。
