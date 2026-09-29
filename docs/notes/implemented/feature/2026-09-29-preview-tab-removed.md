# Agent Note: 删除评分预览页签，并把外部作答提交并入运行记录

Status: implemented — 五个页签，提交与记录同页

## Problem

两件事让「评分预览」与「运行记录」这两个页签都站不住：

1. **评分预览展示的不是任何真实结论。** 它渲染 `examples/assessment.json`——一份固定样例，
   界面上自己写着「输入证据由调用方提供，尚未独立验证」「非正式成绩」。把一份编造的分数
   放在正式工作台的首屏，与项目「不得冒称正式成绩」的纪律直接冲突。
2. **运行记录永远空。** 用户视角是「没用」，但真实原因是**没投料**：
   `BENCH_SUBMISSIONS_DIR` 指向的目录当时根本不存在，而唯一的投料入口
   （外部作答提交）被塞在「发起测评」页签最底部。提交后要看的执行明细却在另一个页签，
   于是「提交完什么反应都没有」——这正是它看起来像死页签的原因。

## Decision

1. **删除评分预览页签。** 连带 `main.tsx` 的接线、`reports`/`activeReport`/`saving` 状态、
   `/api/previews` 请求与「生成示例评分」按钮。**API 侧不动**：`/api/previews` 仍被
   `packages/core/src/scoring.test.ts` 当作评分核心的固定输入，`app.test.ts` 也覆盖它；
   `examples/assessment.json` 仍是那条链的夹具。删的是「把样例当成绩展示」，不是评分本身。
2. **运行记录改名「提交与记录」，并接收提交入口。** 新组件 `SubmitExternalAnswer.tsx`
   从 `LaunchPanel` 搬过来：提交表单、候选读取、令牌输入、结果提示全部保留，
   提交成功后提示语直接指明「它在左边运行记录里，下面可查执行明细与证据」。
3. **共享的 `.report-*` / `.score-*` / `.evidence` 样式一处不动。** 逐个核对过 83 个 CSS 类，
   删除预览后仅 2 个类（`ghost`、`danger`）无组件使用，且都是本次改动之前就存在的孤儿。

## Alternatives considered

- **一并删掉运行记录**（用户最初的倾向）：否决。它是唯一能看到执行事件时间线、逐项检查结果、
  可复核证据 SHA-256、四级汇总加权总分与人工复核的地方；报告中心只覆盖实验级汇总。
  空是因为没投料，不是没用。
- **删 `/api/previews` 与样例 JSON**：否决。评分核心的测试依赖它，删了要连带改评分链的夹具，
  超出「删一个页签」的范围。
- **只把提交入口复制一份到运行记录，不删 LaunchPanel 里的**：否决。两个入口会各自维护候选读取
  与令牌状态，迟早不一致；移动而不是复制。

## Consequences

- 网页从六个页签变为五个：题目目录、提交与记录、报告中心、发起测评、配置。
- 提交外部作答的路径变短：候选放好 → 填幂等键 → 提交 → 同一页看结果。
- `pnpm check` 仍为 412 项（本次没有测试被删，只改了断言）；`pnpm test:e2e` 13 项通过，
  其中 `workbench.spec.ts` 第一项从「断言评分预览显示 85 分」改写为「断言评分预览**不存在**、
  提交入口在提交与记录页签里」。
- 新增供应商或外部作答的候选仍需手工准备目录（`C:UsersADocumentsBenchAnswers` 已创建）。

## Verification

- `pnpm typecheck` 单独跑过一次：删掉 `main.tsx` 的 `qualityLabels`/`number` 与
  `SubmitExternalAnswer` 的 `authHeaders` 后无残留未用符号。
- `pnpm check` exit 0：typecheck + 目录检查 + 412 项测试（28 文件）+ 前端构建。
- `pnpm test:e2e` exit 0：13 项全过。
- 真实提交链路实测（不经过网页表单，直接打 API，验证的是后端仍通）：
  真导出 CACHE-02 参考工作区 → `GET /api/submissions` 列出该候选 → `POST /api/submissions`
  返回 201 / `phase: verified` → `GET /api/runs` 得到 1 条、`classification: passed`。
  全部在系统临时目录完成并回收。
- CSS 逐类核对：83 个类中删除预览后无组件使用的只有 `ghost`、`danger`（既有孤儿），
  因此本次**没有删除任何共享样式**，只新增 `.submit-block`（提交块与记录列表之间的分隔）。

## 与既有 Note 的关系

本 Note 与 [撤销项目自有的供应商档案](2026-09-29-provider-store-withdrawn.md) 同属一次
网页瘦身（六个页签 → 五个）。页签清单的历史变更见
[网页设计系统](2026-09-27-web-design-system.md) 与 [实验报告 API](2026-09-26-experiment-report-api.md)，
后两者记录的是当时的交付态，未受本次影响。
