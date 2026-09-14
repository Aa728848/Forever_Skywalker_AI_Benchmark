# Agent Note: LIFE-02 题目包（流结束、超时和迟到回调）

Status: implemented

## Problem

流式接口的 bug 多半出在**终态之后**：取消/超时/结束之后到达的回调如果还被应用，
汇总就会在“已经交付”之后继续变化（金额被二次累加、错误被新错误覆盖）。
这类缺陷在真实系统里表现为难复现的漂移，而不是一眼可见的崩溃。

## Decision

- 冻结 `StreamCollector`（`push`/`timeout`/`summary`）与 `StreamEvent` 三种事件。
- 缺陷族只有一条：**没有终态概念**（结束、出错、超时之后事件照样生效，超时也不幂等）。
- 参考实现引入显式终态（`open/ended/errored/timed-out`），终态后一律忽略；
  替代实现用 `frozen` 布尔 + `switch` 分派，结构不同但行为一致。
- 为了让检查完全不依赖真实计时器，`timeout()` 由宿主显式调用，`timeoutMs` 只作为配置读出。

## Alternatives considered

- 用真实 `setTimeout` 驱动超时：检查会引入计时抖动，也违反“不依赖真实计时器”的项目口径。
- 把“错误消息只保留第一条”拆成第二个缺陷族：它同属“终态后不再变化”这一根因，保持一题一族。

## Consequences

- 中等档 9/12；核心题 24/48。
- 本题把“终态之后不得再变化”做成了可断言契约（`ended`/`error` 字段 + 快照语义），
  后续的取消传播、订阅释放类题目可以复用同一套终态断言。

## Verification

- `node scripts/task.ts verify LIFE-02`：六阶段通过——起始版本只被 6 个同族检出项判失败，
  参考实现与替代实现全部通过。
- `pnpm check`：exit 0。

