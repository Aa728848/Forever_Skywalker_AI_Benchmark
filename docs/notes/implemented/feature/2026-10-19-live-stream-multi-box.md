# Agent Note: 流式输出按作答分框：并发各看各的，作答过程补齐

Status: implemented

## Problem

「发起测评」页签里的「作答中的实时输出」面板此前有两条硬伤。

1. **并发时所有作答挤在一个面板里**。作答子进程的 stdout 被 supervisor 原样写进 `data/launches/<id>.log`，多路并发时各条作答的行交错落在同一份日志里；前端把整份日志当成一个文本块渲染，于是 3 路并发就是三段对话摞在一起，看不出哪句属于哪条作答。
2. **面板里只有「工具 xxx」**。根因在 `packages/evaluation/src/dsh-comparison.ts` 的 `liveEventLine`：它只认 `event.data.text / delta / content` 三个平铺字段，而 DSH 把助手正文放在 `data.message.content[]`（`assistant/message`）与 `data.stream[]`（`assistant/attempt`）里，取不到；`tool/result` 事件则完全没有处理。结果是助手输出与工具结果从未显示过，面板只剩工具名。
3. **阶段不可见**。作答 / 容器验证与评分 / 结束只写在报告的 `progress` 文案里，而报告不进实时面板。

## Decision

### 1. 日志行改成结构化格式

一行一条事件，形状固定：

```
  题目 · 预设/等级 · 第N次 › 类型: 内容
```

- 「类型」是稳定的英文小写词：`phase / text / think / tool / result / end`。前端按它分色与分组，不拿中文字面量做判断——文案会改，机器词不会。
- 行首带**作答身份**（题目 × 预设/等级 × 第几次），这是并发时能把行归到各自框里的唯一依据。
- 正文压平成一行（事件可能带换行：一行一事件才排得开）；字段之间用全角竖线 `｜` 分隔（`工具名｜参数摘要`、`状态｜工具名｜结果摘要`）。
- launch.log 仍然人可直接读：它同时是排障证据，不因机器可解析而变成不可读。

产出者：`packages/evaluation/src/dsh-comparison.ts` 的 `liveStreamLine` / `livePhaseLine` / `createLiveStreamWriter`。写入器**带状态**——工具结果事件只带 callId、不带工具名，要显示「read 成功」得先记住调用时的工具名；同一次调用在 `assistant/message` 的内容块与 `tool/call` 事件里各出现一次，靠状态去重。

### 2. 阶段走新增的 onPhase 回调

`ComparisonServices` 新增 `onPhase?: (row, phase, detail?) => void`，阶段取 `solving / grading / done / failed / stopped`，标签见 `livePhaseLabels`。

与既有 `onProgress` 的分工是硬约束：**报告里的进度文案一字未动**（`dsh-comparison.test.ts` 对那几条文案有精确断言，而报告是结论载体，不是会话记录）。阶段是给面板的，它额外需要作答身份，否则并发时无法把阶段归到对应的框。

### 3. 前端每条作答一个框

`apps/web/src/liveStream.ts` 是纯解析层（把日志行按身份拆成每条作答的流，认不出的行不丢，留在原始日志里），`apps/web/src/LiveStream.tsx` 是视图层。

- **每排最多两个框**，多的往下排；窄屏（1080px）降为一列。
- **在跑的作答占框，已结束的收成摘要条**：并发 3 时主视图就是 3 个框（其中已结束的那条降为摘要条），不会随着 55 题一路堆成长页。点摘要条进全屏层看那条作答的完整过程。
- **「全部输出」全屏覆盖层**列出所有作答（同样每排两个），Esc 关闭。
- **「原始日志」折叠保留**：多框是主视图，合并文本折叠在下方备查。
- 框内长文本默认折叠，可点开看全文；每个框独立判断「用户上滚后不再被新行顶回去」。
- 发起测评详情里的「报告目录」卡只显示**目录名**（描述性小字），完整绝对路径留在悬停提示里：Windows 的 %TEMP% 路径没有自然断点，会把这一张卡撑成六行、整排卡片参差。报告中心本来就是这个口径（只显示目录名），两处统一。

## Alternatives considered

- **日志改成 NDJSON**：机器解析更直接，但 launch.log 是排障证据，人可读性不能丢。弃用。
- **让 API 直接返回按作答分组的结构**：前端不必解析，但要改协议，且旧日志无法回看。保留「API 只按字节返回增量、前端解析」这一层。
- **把逐 token 会话写进 experiment.json**：报告是结论载体，逐 token 落盘会让报告膨胀且无法复读（沿用既有约束）。
- **新增顶部导航页签「实时输出」**：路径更长；用户要求留在「发起测评」里并考虑独立界面，于是独立界面做成覆盖层而不是新页签。
- **累积所有出现过的框**：55 题会堆成一条很长的页；改为「在跑的占框、结束的收成摘要条」。
- **把阶段塞进既有 progress 文案**：会改报告内容（结论载体），且既有测试对那几条文案有精确断言。否决。

## Consequences

- 并发时每条作答各看各的；面板里能看到阶段、助手输出、工具调用（含关键参数）与工具结果（成功/失败 + 内容摘要），不再只有工具名。
- API 协议未变：`GET /api/experiments/:launchId/stream?offset=` 仍按字节返回增量，前端按行首身份拆分。
- launch.log 里仍混有报告用的原始进度文案（不参与分框，只出现在原始日志里）——那是 `onProgress` 的既有输出，本轮没有改它。
- 已知限制：单个框最多显示最近 120 条事件（全屏层 600 条），更早的只在计数里体现；单条事件的正文由后端截断（正文 4000 字、参数 2000 字、结果 4000 字），因此「展开全文」展开的是日志行携带的全文，不是无限原文。
- 覆盖层必须挂到 `body`（portal）：外层 `.detail` 带 `transform` 动画，`position: fixed` 会被它当包含块而错位。

## Verification

- `pnpm check`：exit 0，**417 项**测试（28 个文件）、`tsc --noEmit`、目录一致、生产构建全部通过。
- 新增单测（`packages/evaluation/src/dsh-comparison.test.ts`）：助手正文取自 `data.message.content[]`、工具调用带参数摘要、工具结果补上工具名且与调用事件不重复、失败结果标 `err`、无关事件不占行、阶段行带作答身份、`onPhase` 在两条作答上依次给出 solving → grading → done。
- 新增 `tests/e2e/live-streams.spec.ts`（1 项通过）：写入启动记录与 launch.log 后，在真实浏览器里断言——在跑的两条作答各占一框且左右并排、框里有工具调用与工具结果、已结束的那条收成摘要条、原始日志折叠存在、全屏层三条作答仍每排两个、Esc 关闭。
- `pnpm test:e2e`：13 项通过、1 项失败（`config-panel.spec.ts` 的「配置」页签读取停在「正在读取配置…」）。**该失败是既有问题、非本次引入**：把本次全部改动 `git stash` 后在干净树上重跑，同一文件仍有 2 项失败，且失败用例集与带改动时不同（属 flaky）。本次未触碰 `ConfigPanel` 与配置 API。
- 未调用真实作答模型或裁判；未改动报告与评分链路。

## Cross-references

- 拥有「发起测评」页签与受控 supervisor 链路的既有决策：[网页操作入口](2026-09-26-web-config-and-launch.md)（其「实时看进度」一行仍成立，细节由本 Note 拥有）。
- 并行度与「作答/验证/评分重叠」的既有决策：[测评并行](2026-09-26-parallel-assessment.md)（并发因此成为常见路径，也才让「所有对话挤在一个面板」显形）。
