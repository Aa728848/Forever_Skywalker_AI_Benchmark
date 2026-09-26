# Agent Note: DSH 评分判决协议中断的诊断与恢复

Status: implemented

## Problem

2026-09-15 12:01 的 CACHE-02 实验（实验 `187fb412-a375-48dd-b9fa-bb772ed569c7`）中，受控执行与性能采样全部通过、功能分 50，但第 2 轮评分会话返回的 JSON 未通过 `ReviewVerdict` 协议校验；`review-error.json` 只留下「DSH 评分 Agent 判决不符合 0.1.0 协议。」。

因为 `composeQuality` 要求每个维度的客观分与评审分同时存在，评审一侧缺失使四维全部为 null，质量分与总分继续待定；同时该轮原始响应与失败字段被丢弃，无法判断模型究竟哪里不符合协议。报告只显示“待定”，不说明原因。

另有一处自相矛盾：提示词声明 `cost` 与 `reviewedAt` 由平台覆盖，适配器却把它们当作模型必须回显的必填字段。模型一旦按提示省略或改写这两个平台自有字段，整份有效判决会被判成协议错误。

## Decision

- 平台字段由平台注入：新增的 `normalizeVerdict` 在协议校验前写入 `cost`（calls=1、未知 token 为 null）与 `reviewedAt`，不再依赖模型回显。
- 记录式归一化：丢弃模型附带的未知顶层/维度字段、对维度内重复的证据引用去重、缺 `notes` 时补空数组，并把每一项写进 `ReviewOutcome.normalizations` 与执行说明；四维分数、证据引用、身份与版本仍按原契约严格校验，不补分也不改分。
- 维度分可声明为不可判（2026-09-26 修正）：`ReviewVerdict` 的四个维度分改用平台既有的 `score` 原语（number | null）。提示词要求「无法从材料判断时拒绝输出判决，不能猜分」，而契约当时只收 number——模型照提示词写 `null` 反而整份判决作废，质量分与总分永远待定。这与 2026-09-15 否决的「放宽契约以接受缺维度判决」不同：`null` **不产生分数**，它让裁判能如实声明某一维不可判，下游据此保持待定；缺证据仍然不得补分（`composeQuality` 见到 null 即让该维待定）。
- notes 形状归一化：提示词要求每条 note 列明六个字段，但模板把 `notes` 展示为空数组，模型无从得知该用字符串还是对象。模板改为给出一个 note 实例；适配器把结构化条目按同一字段顺序压成可读字符串（字符串原样保留），记入 `normalizations`。契约仍只收字符串——形状偏差在适配器消除，不进入契约。
- 下游 null 语义：`QualityReview.score` 允许 null；`composeQuality` 不再对 null 抛 `RangeError`（`Number.isFinite(null)` 为 false），也不把它当 0，而是让该维保持待定并在 `reasons` 说明；`compareReviews` 对两轮均未判定的维度不做均值与分歧运算，并把它们列为待定——否则 `null` 会被静默当成 0，伪造均值并误报「两轮差异超过 20 分」。
- 每维满分取自契约：`compareReviews` 里判断「两轮是否可能跨越门槛」的系数原为四维时代的固定 `0.125`，删除性能维度后每维满分是 `qualityPointsPerDimension`（`50/3`）。改用该常量后系数从 0.225 修正为 0.300，否则门槛交互判断低估 1.33 倍。
- 精确诊断：`packages/contracts` 新增 `explainReviewVerdict`（字段路径）；`@fsa/judge` 新增 `JudgeProtocolError`，携带 `roundId`、原始响应（上限 64 KiB）与字段路径列表；会话未完成时同样保留部分响应。
- 证据留档：评测层在失败轮写出 `review-round-<n>-error.json`（原始响应+字段路径），`review-error.json` 增加 `roundId` 与 `issues`。失败轮证据只作排障，不进入评审材料。
- 报告可读：`renderComparison` 对带评审失败证据的行输出「待定原因」，指出失败轮与证据位置。

## Alternatives considered

- 放宽 `ReviewVerdict` 契约或接受缺维度判决：会让分数在证据不足时产生，违反“缺证据保持 null、不得补分”。仍在否决：维度对象缺失、证据引用为空、身份或版本不符一律判协议错误。2026-09-26 只额外接受**显式** `score: null`，它不产生任何分数。
- 只改错误文案不改校验：仍会丢掉整份有效判决，下次依旧无法定位。
- 把失败轮原始响应直接拼进执行说明：执行说明单条限 2000 字符，超长会再次触发“最终执行证据不符合协议”，因此改为独立证据文件加摘要。
- 一轮失败后补跑第三轮会话：超出“每次作答仅两轮独立会话”的既有预算约束，需要用户明确授权。
- 让界面重填续跑参数：续跑的意义就是不用重选；要求用户重填反而容易填错并造成「配置不一致」的假故障。
- 对坏 JSON 做字符级启发式修复（把中文间的裸引号替换为中文引号）：对损坏文本做手术风险高，可能改坏语义；改为重试取得一份真正有效的响应。
- 单轮失败后接受另一轮的有效判决：会改变「两轮独立判决」的既有约定，需用户明确授权（见上「补跑第三轮会话」条目），本次不做。
- 保留「差异超过 20 分即整份作废」：实测会让 12 题里唯一的有效判决变成待定，代价明显大于收益。改为取平均后，一个虚高的 100 分与一个 78 分平均为 89，仍显著低于第一轮那个自相矛盾的满分。
- 把「两轮不可比」也静默平均：那会把两个不同实验条件的分数混成一个而不留痕迹，因此仍写进 notes 与 `comparison.comparabilityWarnings`，只是不再阻断评分。

## Consequences

- 模型省略或改写平台自有字段、附带装饰字段，不再导致整次评分作废；被替换或丢弃的字段留在 `normalizations` 中可审计。
- 两轮独立判决的规则没有改变：任一轮仍必须通过协议校验，缺证据的评审分继续为 null，总分待定。
- **两轮不同一律取平均，不再因分歧作废评审分**（2026-09-26 修正，用户决定）：原实现任两维差异超过 20 分即 `needsHumanReview`，调用方随即丢弃两轮结果，质量分与总分一起待定。实测一次 12 题的真实作答里，LSP-01 因此成为**唯一**的待定项——而它两轮都是有效判决（第 1 轮 100/100/100，第 2 轮 78/80/80）。现在 `compareReviews` 直接给出两轮平均，差异只逐维记录在 `differences` 与 `reasons` 里供复核参考。
- 「两轮不可比」与「两轮分数不同」是两件事：前者（配置指纹、服务端返回模型、DSH 运行时或预设指纹不一致，以及两轮给出不同门槛结论）记入 `comparabilityWarnings` 并保留 `needsHumanReview=true` 告警，但**分数照样取平均**；只有「两轮都判不可判」才是真正没有可平均的东西，此时评审分保持缺失。
- 裁判可如实声明某一维不可判：该维待定，其余维照常合成；质量分与总分仍要求四维齐备，因此只要有一维不可判，总分就是待定而不是打折分。
- 只有四维都有可信分数时才会产生质量分。声明不可判因此是「如实留白」，不是「通过」的捷径。
- 失败轮的模型原文会进入证据包（本机 `data/` 下的运行产物）。
- 已有历史实验目录不被改写；旧实验仍需重新运行或重新评分才能取得质量分。

## Verification
- 续跑：`packages/evaluation/src/dsh-comparison.test.ts` 断言只重跑未完成/待定的行、落定分数不变、续跑后无待定行；
  反向验证两条承重判据——把 `isSettledRow` 改回只看 `phase` 后只重跑 1 条（应为 2 条）而失败；
  把证据归档改回 `wx` 后因 `EEXIST` 失败。
- 轮次重试：`dsh-judge.test.ts` 覆盖「第 1 轮坏 JSON→重试成功」与「第 2 轮坏 JSON→重试成功」两轮闭环；
  反向验证把 `sessionAttemptsPerRound` 设为 1 即失败。
- 真实报告核对：对 `exp-2026-09-26T11-21-31-129Z-32e16e34`（55 行、state=failed）套用 `isSettledRow`，
  续跑复用 46 行、重跑 9 行，用户截图里需要修的 9 个题 9/9 覆盖、零遗漏。
- 网页按钮：真实报告做夹具，e2e 断言按钮文案为「续跑未完成的 9 条」且可用。
- 解回证据：`comparison-artifacts.test.ts` 断言解回后 run store 能读到历史作答、不覆盖本次同名文件、
  拒绝越界路径与摘要不符；反向验证把解回改成空操作即失败（`expected +0 to be 1`）。
- 真实续跑（`exp-2026-09-26T11-21-31-129Z-32e16e34`，55 题）：复用 46 行、重跑 9 行，
  9 条问题题全部拿到数值总分——GRAPH-04 93.63、STATE-01 97.6、STATE-03 96.55、INT-HARNESS 95.11、
  INT-SUB 93.36、INT-VERIFIER 93.23、INT-TRADING 98、INT-WEB 95.51、INT-PY 96.54；**55/55 已落定、0 待定**。
- `pnpm check` exit 0（376 项）；`pnpm test:e2e` 9 项通过。
- 取平均语义：`packages/judge` 58 项通过，含改写后的「两轮不同就取平均，分歧本身不再要求人工复核」。
- **反向验证（承重的判定）**：把 `packages/evaluation/src/index.ts` 里落地评审分的条件从 `unjudgedEverywhere` 改回「`needsHumanReview` 即作废」，`evaluation.test.ts` 的「三维齐备」用例立刻失败（`expected null to be 88`）——正是 LSP-01 当时的表现。恢复后通过。
- 端到端：`pnpm check` exit 0（364 项）；`pnpm test:e2e` 9 项通过。

- `node node_modules/typescript/bin/tsc --noEmit`：通过。
- `node node_modules/vitest/vitest.mjs run packages/evaluation/src/dsh-judge.test.ts --pool=threads`：7/7 通过，含 3 项新增（平台字段缺失仍评分并记录归一化、判决违约保留原始响应与字段路径、会话未完成保留部分响应）。
- 新增的 `evaluation.test.ts` 轮次证据用例：`review-round-2-error.json` 原始响应、`review-error.json` 的 `roundId=2`、质量/总分待定等断言全部通过；该用例与既有 3 项一样，最后在 `functional: 50` 断言处失败，原因是当前沙箱不允许以管道启动候选子进程（spawn EPERM），候选检查全部 not-run。
- 全量回归 `--pool=threads`：237 通过 / 22 失败，22 项失败全部表现为 `functional: 0` 或空目录（executor/static/tasks/api/launcher/dsh-catalog/dsh-comparison），与本次改动无关。沙箱限制见本 Note 的说明；正常环境下需重跑 `pnpm check` 复核。
- 独立 harness（`node --experimental-transform-types`，23 项断言，覆盖真实 `verifySubmission` 链路）全部通过：第 2 轮失败写出 `review-round-2-error.json`、`review-error.json` 记录轮次、质量/总分保持 null、执行说明可定位且不超 2000 字符。