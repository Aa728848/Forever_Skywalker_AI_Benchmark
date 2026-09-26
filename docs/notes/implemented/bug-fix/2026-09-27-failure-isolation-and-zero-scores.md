# Agent Note: 单题失败不再中止整轮；超时与 check 不通过直接判 0

Status: implemented

## Problem

一次 55 题实验（`exp-2026-09-26T17-22-46-133Z-6d336532`，stepfun + 并行度 3）只跑完 4 题就 `failed`，
其余 51 题停在 `pending`。报告里唯一的问题是：

```
initialize timed out after 10000ms waiting for dsh profile "sdk"
```

三个独立缺陷叠在一起：

1. **DSH 的 initialize 超时默认 10 秒**（`sdk/client/src/launch.ts` 的 `DEFAULT_INITIALIZE_TIMEOUT_MS`），
   那是按**单进程**启动估的。并行测评同时拉起多个 DSH 进程，每个都要加载 profile、插件与适配器；
   实测 3 路并行时第 4 个会话恰好在 10 秒处超时。项目侧从未设置这个上限。
2. **单题失败中止整轮**：`runRow` 的 catch 里 `requestStop('failed')` 后重新抛出，
   于是任何一题的抖动都会让实验 failed，其余题不再被派发。
3. **超时留成待定**：`finishReason !== 'completed'` 直接 `solver-stopped` 并 return，
   该行没有 evaluation，总分保持待定——用户看到的是一份没有成绩的报告。

另外，`check-failed` 原先按**通过项权重比例**给部分分（实测 ARCH-04 因此拿到 79.58 总分），
用户要求 check 不通过直接判 0。

## Decision

1. `DshRunOptions.initializeTimeoutMs` 新增；`dshInitializeTimeoutMs(concurrency)` 是这一个事实的
   唯一归属（`30s + 15s × 并发`），作答与裁判都用它——两者都会并发启动 DSH 会话。
   裁判侧经 `BENCH_JUDGE_DSH_INITIALIZE_TIMEOUT_MS` 注入，与既有 `BENCH_JUDGE_DSH_*` 同源。
2. **单题失败不再中止整轮**。只有三类仍然中止，因为它们说明后续作答不可能正确或环境已不可信：
   取消、`DshCleanupError`（运行时回收未确认）、以及**同类失败反复出现**之外的全局漂移（见第 4 条）。
   其余（初始化超时、容器故障、单题异常）记为该题失败并继续。
3. **作答未完成（超时/内存/异常结束）仍走进容器验证并按 0 分计**：超时是明确的失败结论，
   不是「无法判断」。`scoreExecution` 已把未取得的检查项按被测失败记 0。取消才真的没有结论。
4. **漂移改为记录并继续**：`comparisonGroups` 在 drift 非空时已经把各组均分置为 null
   （报告显示「待定」、不合并不可比的分数），诚实性不依赖中途停下；而中止的代价是丢掉其余全部作答。
5. **check 不通过直接判 0**（`checkFailed` 时 `functional = 0`）：按通过项比例给部分分会让
   「没通过」看起来像「差不多通过」。质量分仍由裁判独立评——用户明确只要求可用验证分归零。
   未取得结论的两种情形（基础设施故障、取消）保持 null，那是「无法判断」，与「没通过」不同。

## Alternatives considered

- **只调大超时、不动失败传播**：仍会因为任何一题抖动丢掉整轮，而并行度越高抖动越常见。
- **单题失败后重试该题**：用户选择了「记 0 分并继续」，重试会显著拉长实验且不做保证；未采用。
- **漂移仍然中止**：`comparisonGroups` 已拒绝合并漂移结果，中止只额外丢弃作答，不增加诚实性。
- **把 check 不通过也算成「未取得结论」（null/待定）**：与用户要求相反，且「没通过」本就是明确结论。

## Consequences

- 一轮实验不会因为个别题的抖动而以 failed 结束；失败原因逐行记在 `row.error` 与进度日志里。
- 超时/未完成的题拿到 0 分而不是待定；报告不再出现大量「待定」。
- 漂移时报告仍拒绝合并分数（各组显示「待定」），并新增一条说明原因的 issue。
- 后果是「有分数的报告」更常见，因此**发布前的分数必须看 `classification` 与 `reasons`**，
  不能只看总分——0 分可能来自 check 不通过或超时，原因都写在那一行上。

## Verification

- 真实现场：续跑 `exp-2026-09-26T17-22-46-133Z-6d336532`（复用 6 条、重跑 49 条，并行度 3）
  未再出现 initialize 超时。
- 反向验证：把 catch 里的「继续」改回「中止」，新增用例立刻失败
  （`expected 'failed' to be 'completed'`）；恢复后 `packages/evaluation` 81 项全过。
- `dsh-comparison.test.ts` 新增「单题作答失败不中止整轮」，并改写「作答未完成仍按 0 分验证；
  取消才停止」；`scoring.test.ts` 改写「check 不通过记 0」与「全通过但分类异常时记 0」；
  `executor.test.ts` 与 `app.test.ts` 的 `functional > 0` 断言按新规则改为 0。
- `pnpm check` exit 0（380 项）；`pnpm test:e2e` 9 项通过。