# Agent Note: 消除「待定」——评审轮次互相独立、按维取可用轮次

Status: implemented

## Problem

四份真实实验报告（deepseek / stepfun / Google / MiniMax，各 55 题）里出现 4 条「质量分与总分待定」，
用户要求「不能出现待定」。逐条取证后发现是**三个独立缺陷**叠加，没有一条是模型作答失败：

| 模型 | 题目 | 可用验证 | 缺哪一维 | 真实原因 |
| --- | --- | --- | --- | --- |
| Google | LSP-02 | passed 50 | 三维 | 第 1 轮会话 `error`；**第 2 轮从未发起** |
| MiniMax | ARCH-01 | passed 50 | 三维 | 第 2 轮响应不是合法 JSON；**第 1 轮三维都是有效分数** |
| MiniMax | INT-WEB | passed 50 | 三维 | 第 2 轮会话 `timeout`；**第 1 轮三维都是有效分数** |
| MiniMax | LSP-02 | passed 50 | simplicity | 第 1 轮声明 simplicity 不可判、**第 2 轮给出 85** |

1. **轮次不独立**：`createQualityProvider` 对第 1 轮 `await` 后直接抛出，第 1 轮一失败第 2 轮根本不发起；
   第 2 轮失败则把第 1 轮已取得的有效判决一起丢掉。
2. **要求两轮同时给出分数**：`compareReviews` 的 `judged(key)` 要求两轮**都**非 null，
   于是「一轮声明不可判、另一轮给了分」这种最普通的形态被判成该维待定。
3. **一行缺失拖垮整组**：`comparisonGroups` 的 `values.some(value => value === null)` 让**任意一行**缺失
   就把整组均分置为 null——MiniMax 那轮 48 道核心题里 45 道都有分数，却整组显示「待定」，
   把 94% 的真实成绩藏了起来。

另有一处报告缺陷：`renderComparison` 把每条带失败轮的行都写成「独立评审未通过协议校验」，
而 MiniMax 的 LSP-02 其实是**协议通过、只是一轮声明不可判**，文案与事实不符。

## Decision

1. **两轮互相独立**（`packages/evaluation/src/index.ts`）：两轮都发起、各自留档（`review-round-N.json` /
   `review-round-N-error.json`），成功的几轮进入合并。轮次 id 与结果一同保存——
   只按数组下标回推轮次会在第 1 轮失败时把第 2 轮错标成第 1 轮。
2. **单轮也可成立**（`packages/judge/src/comparison.ts` 新增 `mergeReviewRounds`）：
   仅剩一轮有效判决时直接采用，并写入 `comparabilityWarnings`「只有 1 轮有效判决……未经第二轮交叉验证」。
   `compareReviews(first, second)` 保留为两轮兼容入口，语义等同 `mergeReviewRounds([first, second])`。
3. **按维取可用轮次**：某维两轮都有分就取平均，只有一轮有分就用该轮，**所有轮次都没有才为 null**。
   新增 `roundsJudged` 逐维报出「实际给出分数的轮次数量」。
   这里用的每一分都是裁判真实给出的分数，没有任何推断值，因此不违反「缺证据不得补分」。
4. **均分只统计有分数的行**：`comparisonGroups` 新增 `functionalRows`/`qualityRows`/`totalRows`，
   只对非 null 取平均，并把覆盖率写进报告新增的「计入均分行数」列。
   `drift` 非空时仍然拒绝合并——不同环境或裁判的分数不能混成一个均值。
5. **文案与事实一致**：报告区分「失败轮」与「有效轮次」，并给出该行分数来自几轮。

## Alternatives considered

- **补跑第三轮会话**：2026-09-15 曾以「超出每次作答仅两轮独立会话的预算」否决。
  本次不需要它——轮次独立后，两轮照常发起、有几轮成功用几轮，不增加任何会话。
- **把缺失行当 0 参与平均**：会伪造分数（未取得结论 ≠ 没做好），否决。改用「只对非 null 取平均 + 显式覆盖率」。
- **放宽契约接受缺维度判决**：仍在否决。维度对象缺失、证据引用为空、身份或版本不符一律判协议错误；
  2026-09-26 起只额外接受**显式** `score: null`，它不产生任何分数。
- **对坏 JSON 做字符级修复**：对损坏文本做手术风险高（实测 MiniMax ARCH-01 的原文有 89 个引号、
  奇数个，属真正未闭合），否决。改为「该轮如实失败、用另一轮」。
- **让均分继续整组待定**：会让「48 题里 45 题有分」看起来像「全都没分」，把真实成绩藏起来，否决。

## Consequences

- 真正的待定只剩一种情形：**所有取得的轮次都没有判定任何维度**。上述 4 条里 3 条因此恢复出分数
  （MiniMax LSP-02 95.88、ARCH-01 100、INT-WEB 94）；Google 的 LSP-02 两轮都没有有效判决，
  **仍然必须待定**——它没有任何可用的评审分，不补分。
- 单轮结论的置信度低于两轮平均，因此必须留告警；报告与 `review-comparison.json` 都能看到。
- 均分覆盖率成为必读字段：看到均分必须同时看「计入均分行数」，否则会把部分覆盖误当成全量。
- 历史实验目录不被改写；已归档的报告要在新代码下重新评分才会得到上述修正分数。
  分析侧的做法见 `data/analysis/build-corrections.mjs`（按新规则重算并留 `pending-corrections.json`）。

## Verification

- 保真度自检：用 4 份报告里**已落定**的 216 行反推合成公式（客观分×权重＋评审分×(1−权重)，
  每维满分 50/3），216/216 与产品输出完全一致——证明重算脚本与 `scoreExecution` 同口径。
- `packages/evaluation/src/evaluation.test.ts`：新增「第 1 轮会话失败时仍发起第 2 轮并采用它的判决，
  不再整题待定」；改写「第 2 轮协议错误时仍采用第 1 轮的有效判决」。
  反向验证：把第 1 轮的 `await` 改回直接抛出即失败（第 2 轮从未发起）。
- `packages/judge/src/judge.test.ts`：新增「某一维只有一轮给出分数时采用该轮」「只剩一轮直接采用并告警」
  「所有轮次都未判定才待定」「拒绝合并不属于同一冻结作答的判决」。
  反向验证：把 `roundsJudged` 改回「两轮同时给出才算」即失败（`expected 1 to be 0`）。
- `packages/evaluation/src/dsh-comparison.test.ts`：改写「缺一行不再把整组置为 null」并断言
  `functionalRows` 反映真实覆盖率。反向验证：把 `average` 改回 `values.some(v => v === null)` 即失败。
- `pnpm check` exit 0（428 项，29 个文件）。

## Related

- `2026-09-15-dsh-judge-protocol-diagnostics.md`（拥有裁判协议与失败留档；本次推翻其中
  「单轮失败后接受另一轮需授权」与「两轮齐备才给分」两条）。
- `2026-09-27-failure-isolation-and-zero-scores.md`（拥有「单题失败不中止整轮」与「check 不通过判 0」；
  本笔记修正其中「漂移以外只要有一行为 null 就整组待定」的聚合口径）。
