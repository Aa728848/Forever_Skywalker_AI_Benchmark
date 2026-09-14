# BND-01 · CLI 参数与零值语义

- 难度：简单；题型：独立核心题；能力域：参数与边界解析。运行时：TypeScript on Node.js 24。题目版本：0.1.0。

## 背景

`starter/src/cli.ts` 解析命令行选项。当前实现用 `||` 处理可选值，
于是 `--port 0` 与 `--tag ""` 被当成“未提供”退回默认值；未知选项被静默忽略；重复选项取第一次；缺值时静默用空串。
请在**不改变公开接口**的前提下修复。

## 公开接口（冻结）

```ts
export interface CliDefaults { readonly host: string; readonly port: number; readonly tag: string; readonly verbose: boolean }
export interface ParsedCli extends CliDefaults { readonly rest: readonly string[] }
export class CliUsageError extends Error { readonly option: string }
export function parseCli(argv: readonly string[], defaults: CliDefaults): ParsedCli;
```

## 必须满足的行为契约

1. `--key=value` 与 `--key value` 等价；未提供的选项保留默认值。
2. `--port 0` 与 `--tag ""` 必须按字面取值，不得退回默认值。
3. 未知选项抛 `CliUsageError`，`option` 为去掉 `--` 的选项名。
4. 取值选项缺少取值（后面没有参数或以 `--` 开头）抛 `CliUsageError`。
5. `--port` 必须是非负十进制整数且 ≤ 65535；否则抛 `CliUsageError`（option 为 `port`）。
6. `--verbose` / `--no-verbose` 切换布尔；布尔选项不接受 `=value`。
7. 重复选项最后一次生效；非选项参数按出现顺序进入 `rest`；`--` 之后的内容原样进入 `rest`（即使看起来像选项）。

## 限制

- 只改 `starter/`；不得引入第三方依赖；不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

## 判定

- 参考实现通过全部公开与未公开检查；缺陷起始版本只被声明的检出项判失败；替代实现同样通过。
- 本阶段产出检查结论与可用验证分；代码质量评审接入前总分保持待定。
