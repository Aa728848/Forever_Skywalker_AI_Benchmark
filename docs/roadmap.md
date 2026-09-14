# 开发阶段与验收

范围于 2026-09-14 经用户确认。每阶段以可运行证据验收，不用目录数量或占位文件代替完成度。

具体接手步骤、执行项依赖和首个任务见 [开发交接与执行手册](handoff.md)。

## M0：本次初始化

| 交付 | 状态 | 验收 |
| --- | --- | --- |
| 需求、架构、评分、执行记录设计 | 已编写 | 与确认需求一致、限制明确 |
| 七个来源项目记录 | 已编写 | 提交与路径可定位，标明基线未运行 |
| 48 核心 + 7 集成题设计目录 | 已实现 | Schema、ID 唯一、四级覆盖、Markdown 同步 |
| 评分核心与分级汇总 | 已实现 | 50/50、门槛、缺失、错误、证据与重复作答回归 |
| CLI 与 API | 已实现 | 列目录、查看题、计算预览、持久化与严格输入校验 |
| 中文题库及报告面板 | 已实现 | 筛选、预览生成、刷新后报告、窄屏布局 |
| 正式题目执行夹具 | 未实现 | 不得标记题目为 ready |
| 完成检测和容器执行 | 未实现 | 不得用示例预览替代正式验证 |
| 独立 AI 裁判 | 未实现 | 当前不发起模型调用 |

初始化验证命令：

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm browsers:install
pnpm test:e2e
pnpm bench list
pnpm bench show CACHE-01
pnpm bench score examples/assessment.json --format markdown
```

最终执行结果记录在本次 [架构 Note](notes/implemented/architecture/2026-09-14-benchmark-initialization.md)。浏览器测试使用 Playwright 管理本任务专属服务，不复用已占用端口。测试截图/trace 存于已忽略的 `test-results`，不是已实现的正式题目证据。

## M1：首批真实任务与受控执行

先实现 8 道试点：FE-01、LSP-01、CACHE-02、BND-02、THR-03、GRAPH-03、CONC-04、PERF-04，覆盖四个等级。它们用于验证题目制作和执行成本；试点数据不足 48 道时不能生成完整核心成绩。

每题必须具备：独立起始仓库、公开题目、参考补丁、真实缺陷复现、公开/保留用例、受控执行命令、环境摘要、明确门槛与最低资源预算。实际制作时允许基于校准调整设计，但要提升题目版本并记录原因。

实现显式提交、冻结快照、幂等完成事件、Linux 容器执行、Node/.NET 运行适配与可信结果采集。验证参考解全过、坏解被检出、超时与环境失败分类、候选无法写评分器、子进程可回收。

执行项状态（依赖顺序与验收判据见[交接手册](handoff.md) §4）：

| 执行项 | 状态 | 证据 |
| --- | --- | --- |
| M1-01 CACHE-02 真实题目包 | 已完成 | [Agent Note](notes/implemented/feature/2026-09-14-cache-02-task-package.md)；`node scripts/task.ts verify CACHE-02` 六阶段通过 |
| M1-02 提交信封与冻结快照 | 已完成 | [Agent Note](notes/implemented/feature/2026-09-14-submission-freeze-control-plane.md)；`node scripts/run.ts` 演练 8 步，含同键冲突与篡改快照两个预期失败 |
| M1-03 最小独立执行器 | 部分完成：执行器、故障分类、回收与**容器档案**均已实现并接线；只剩“在真实容器里跑一次” | [执行器 Note](notes/implemented/feature/2026-09-14-minimal-executor-and-fault-classification.md)、[容器档案 Note](notes/implemented/feature/2026-09-14-container-profile-and-pinned-image.md)（含 runbook） |
| M1-04 提交入口与状态查询 | 已完成 | [Agent Note](notes/implemented/feature/2026-09-14-submit-entry-and-run-status.md)；`pnpm bench submit` 自动验证、同键复用、`bench status` 可查 |
| M1-05 其余 7 道试点 | 已完成 | [Agent Note](notes/implemented/feature/2026-09-14-m1-pilot-pack-and-trial.md)；7 道题各自 `node scripts/task.ts verify <ID>` 六阶段通过 |
| M1-06 试跑报告与 M2 交接 | 已完成 | [M1 试点试跑报告](trials/2026-09-14-m1-pilot.md)；`node scripts/trial.ts` 8/8 通过 |

M1-01 只建立一道题目的真实资产与导出/验证路径；其余 54 道仍是设计规格，不能据此宣称题库已可执行。
M1 交付时 `pnpm check`（53 项 vitest）、`pnpm test:e2e`、8 道题的 `task:verify` 与 8 题试跑（`pnpm trial`）均已通过。

## M2：核心题库与独立评审

进度（2026-09-14 起）：正式评分桥已落地（`scoreExecution`：受控执行结果 → 可用验证分，质量缺失时总分待定）；题目包生成器 `scripts/newtask.ts` 可一份规格产出一道题的全套资产并自动三向验证；核心题完成 14/48（8 道试点 + CACHE-01、API-01、BND-01、LIFE-01、GRAPH-01、STATE-01），其余 34 道按批次制作。

完成全部 48 道核心题；按题族保留隐藏数据；接入独立裁判及人工复核。实现固定模型和提示版本、评审证据引用、分歧处理、缓存键、预算与失败状态。

前端增加正式 run/attempt 时间线、取消/重试状态、四级汇总、比较相同运行档案的报告、Markdown/JSON 导出。核心分数与预览存储分开，正式分数只能来自受控执行链。

用不同能力的作答者校准难度、分数区分度、裁判一致性和性能噪声；公布运行档案与环境要求。题目、运行环境、评分器任一变化都需要新版本。

## M3：原仓库集成与跨平台发布

完成 7 道集成题和 Python 适配器，固定来源提交、submodule 与依赖；在隔离副本中运行基线与隐藏回归。补齐 Windows/LSP 实际进程与文件路径专项，使用独立环境分数。

准备发布审计：来源/许可清单、任务泄漏检查、完整执行证据、参考解与有代表性的错误解、重放说明和运行成本。未满足发布门槛的题保持 designed 或校准中，不进入正式总分分母。

## 发布门槛

1. 题目契约与隐藏检查一致，隐藏数据没有引入新需求。
2. 正确参考实现、独立替代实现和缺陷实现形成有效对照。
3. 线程与故障用例能够通过固定交错重复触发，性能阈值已有实测基线。
4. 完成信号、快照、验证、裁判、分数和复核可追溯到同一 attempt。
5. 基础设施故障不计为模型错误，评分不接受伪造成功日志。
6. 同赛道的环境、预算和作答次数相同；完整和部分结果明确区分。
