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
- 精确诊断：`packages/contracts` 新增 `explainReviewVerdict`（字段路径）；`@fsa/judge` 新增 `JudgeProtocolError`，携带 `roundId`、原始响应（上限 64 KiB）与字段路径列表；会话未完成时同样保留部分响应。
- 证据留档：评测层在失败轮写出 `review-round-<n>-error.json`（原始响应+字段路径），`review-error.json` 增加 `roundId` 与 `issues`。失败轮证据只作排障，不进入评审材料。
- 报告可读：`renderComparison` 对带评审失败证据的行输出「待定原因」，指出失败轮与证据位置。

## Alternatives considered

- 放宽 `ReviewVerdict` 契约或接受缺维度判决：会让分数在证据不足时产生，违反“缺证据保持 null、不得补分”。仍在否决：维度对象缺失、证据引用为空、身份或版本不符一律判协议错误。2026-09-26 只额外接受**显式** `score: null`，它不产生任何分数。
- 只改错误文案不改校验：仍会丢掉整份有效判决，下次依旧无法定位。
- 把失败轮原始响应直接拼进执行说明：执行说明单条限 2000 字符，超长会再次触发“最终执行证据不符合协议”，因此改为独立证据文件加摘要。
- 一轮失败后补跑第三轮会话：超出“每次作答仅两轮独立会话”的既有预算约束，需要用户明确授权。

## Consequences

- 模型省略或改写平台自有字段、附带装饰字段，不再导致整次评分作废；被替换或丢弃的字段留在 `normalizations` 中可审计。
- 两轮独立判决的规则没有改变：任一轮仍必须通过协议校验，缺证据的评审分继续为 null，总分待定。
- 裁判可如实声明某一维不可判：该维待定，其余维照常合成；质量分与总分仍要求四维齐备，因此只要有一维不可判，总分就是待定而不是打折分。
- 只有四维都有可信分数时才会产生质量分。声明不可判因此是「如实留白」，不是「通过」的捷径。
- 失败轮的模型原文会进入证据包（本机 `data/` 下的运行产物）。
- 已有历史实验目录不被改写；旧实验仍需重新运行或重新评分才能取得质量分。

## Verification

- `node node_modules/typescript/bin/tsc --noEmit`：通过。
- `node node_modules/vitest/vitest.mjs run packages/evaluation/src/dsh-judge.test.ts --pool=threads`：7/7 通过，含 3 项新增（平台字段缺失仍评分并记录归一化、判决违约保留原始响应与字段路径、会话未完成保留部分响应）。
- 新增的 `evaluation.test.ts` 轮次证据用例：`review-round-2-error.json` 原始响应、`review-error.json` 的 `roundId=2`、质量/总分待定等断言全部通过；该用例与既有 3 项一样，最后在 `functional: 50` 断言处失败，原因是当前沙箱不允许以管道启动候选子进程（spawn EPERM），候选检查全部 not-run。
- 全量回归 `--pool=threads`：237 通过 / 22 失败，22 项失败全部表现为 `functional: 0` 或空目录（executor/static/tasks/api/launcher/dsh-catalog/dsh-comparison），与本次改动无关。沙箱限制见本 Note 的说明；正常环境下需重跑 `pnpm check` 复核。
- 独立 harness（`node --experimental-transform-types`，23 项断言，覆盖真实 `verifySubmission` 链路）全部通过：第 2 轮失败写出 `review-round-2-error.json`、`review-error.json` 记录轮次、质量/总分保持 null、执行说明可定位且不超 2000 字符。
