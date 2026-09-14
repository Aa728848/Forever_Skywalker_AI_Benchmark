# ARCH-01 · 浏览器与宿主依赖边界

- 难度：简单；题型：独立核心题；能力域：耦合与解耦。运行时：TypeScript on Node.js 24。题目版本：0.1.0。

## 背景

`starter/src/settings.ts` 从宿主读取配置。当前实现直接读 `process.env`（绕过注入端口、且优先级错误），
并用模块级缓存把第一次的结果永久固定下来。请在**不改变公开接口**的前提下修复。

## 公开接口（冻结）

```ts
export interface HostPort { readSetting(key: string): string | null }
export interface Settings { readonly mode: 'dev' | 'prod'; readonly endpoint: string; readonly retries: number }
export class SettingsError extends Error { readonly key: string }
export function resolveSettings(port: HostPort): Settings;
```

## 必须满足的行为契约

1. **所有**宿主配置只能通过传入的 `HostPort` 读取：不得读取 `process.env`、`globalThis` 宿主状态或其它宿主全局，端口的值始终优先。
2. 不得跨调用缓存：同一个端口对象在两次调用之间改变返回值，第二次调用必须看到新值。
3. `mode` 只接受 `'prod'`（取 prod），其它值或缺省取 `'dev'`。
4. `endpoint` 必填且非空白，缺失或空白抛 `SettingsError`（`key` 为 `'endpoint'`）。
5. `retries` 缺省 3，必须是 0..10 的十进制整数，否则抛 `SettingsError`（`key` 为 `'retries'`）。
6. 返回冻结对象；调用不得修改传入的端口对象，也不得给它新增字段。

## 限制

- 只改 `starter/`；不得引入第三方依赖；不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

## 判定

- 参考实现通过全部公开与未公开检查；缺陷起始版本只被声明的检出项判失败；替代实现同样通过。
- 本阶段产出检查结论与可用验证分；代码质量评审接入前总分保持待定。
