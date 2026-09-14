# BND-02 · 严格裁判输出和嵌套工具参数

- 难度：中等；题型：独立核心题；能力域：参数与边界解析。
- 运行时：TypeScript on Node.js 24（依赖 Node 原生类型剥离，仅可使用可擦除语法）。
- 题目版本：0.2.0；评分规则版本：0.1.0。

## 背景

`starter/` 是一个可独立运行的最小项目，`starter/src/verdict.ts` 负责解析模型裁判的原始输出。
当前实现用贪婪正则抓取第一个 `{` 到最后一个 `}`，既不认围栏块，也不解析再编码一层的工具参数。
请在**不改变公开接口**的前提下修复。

## 公开接口（冻结，不得修改签名、导出名与文件路径）

```ts
export interface Verdict { readonly winner: string; readonly scores: Readonly<Record<string, number>>; readonly rationale: string }
export interface ToolCall { readonly name: string; readonly arguments: Readonly<Record<string, unknown>> }
export type VerdictErrorCode = 'missing-block' | 'multiple-blocks' | 'invalid-json' | 'invalid-shape' | 'invalid-arguments';
export class VerdictFormatError extends Error { readonly code: VerdictErrorCode }
export function parseVerdict(raw: string): Verdict;
export function parseToolCalls(raw: string): ToolCall[];
```

## 必须满足的行为契约

1. 判定块是 info 为 `json` 的成对围栏块（` ```json ` 开头、` ``` ` 结尾）。合法输入必须**恰好一个**这样的块：
   没有 → `missing-block`；多于一个 → `multiple-blocks`；json 块没有闭合 → `invalid-json`。
2. 只有围栏块内部的内容才算候选 JSON：围栏外的说明文字、其它 info 的围栏块（例如 ` ```text `）都可能包含花括号或反引号，不得影响判定。
3. 块内必须是单个 JSON 对象，且 `winner` 为非空字符串、`scores` 为对象且每个值是 0–100 的有限数、`rationale` 为非空字符串；
   JSON 语法错 → `invalid-json`；结构不符 → `invalid-shape`。
4. `parseToolCalls` 同样只认那一个 json 围栏块，块内必须是 JSON 数组，元素形如 `{ "name": 非空字符串, "arguments": 对象或字符串 }`；
   `arguments` 是字符串时必须再解析一次成 JSON 对象；数组元素顺序必须保持。
5. 工具调用的任何结构问题（不是数组、元素不是对象、缺 `name`、`arguments` 既不是对象也不是字符串、字符串不是合法 JSON 或不是对象）→ `invalid-arguments`。
6. 输入字符串不得被修改；同一输入重复解析结果一致，且每次返回新的 `scores` 对象。
7. 不得用贪婪正则从原始文本里抓取 JSON；必须按围栏边界与 JSON 语法解析。

## 限制

- 答案范围限于 `starter/`；不要修改 `public-tests/`。
- 不得引入第三方运行时依赖。
- 只能使用可擦除的 TypeScript 语法：不得使用 `enum`、`namespace`、构造函数参数属性。

## 公开检查

在**工作区根目录**运行：

```powershell
node --test --test-isolation=none --test-reporter=tap "public-tests/**/*.test.ts"
```

公开检查只覆盖契约的一部分；正式判定还会在冻结快照上追加未公开的转义、嵌套与围栏组合。

## 判定

- 参考实现通过全部公开与未公开检查。
- 注入目标缺陷的起始版本必须被检出（失败项限于预先声明的检出项），其余已正确行为不得回归。
- 与参考实现结构不同的替代实现也必须通过同一契约。
- 本阶段只产出检查通过或失败；代码质量评审接入前总分保持待定。

## 0.2.0 围栏语法与对象语义

围栏是独占一行、允许前后空格或tab的至少3个反引号；开围栏的余下info trim后大小写不敏感等于json才是判定块。闭围栏必须只有不少于开围栏数量的反引号和空白。任何非JSON块内部都不再识别新开围栏；JSON字符串里的反引号不是独占围栏行则只是普通正文。支持LF/CRLF，非JSON未闭合块余下内容忽略。未闭合JSON优先于完整块数量错误；完整块计数先于JSON结构校验。

scores允许0到100之间合法小数，所有字符串键（含__proto__、constructor）必须保留为普通自有数据属性，不改变对象原型。工具arguments字符串只额外JSON解码一次；二次解码后仍为字符串/数组/null均拒绝invalid-arguments。

