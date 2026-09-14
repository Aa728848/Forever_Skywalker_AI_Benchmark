# Agent Note: 深环检查避免差异诊断耗尽容器内存

Status: implemented

## Problem

GRAPH-04 0.2.0 在固定 Linux 容器首跑中，参考和替代实现均通过，但 starter 隐藏阶段
被 OOM 杀死，十个隐藏检查全部缺失。单独运行 `hidden/resource-deep-cycle-terminates`
也会 SIGKILL。起因是 starter 仅返回两个节点，而断言对它和 20,000 节点预期结果生成
完整数组差异，消耗了测试容器的 512 MiB；这不是有效的预声明缺陷检出。

## Decision

仅修改该深环断言：检查数组类型、长度，再按位置逐项精确比较，使错误诊断只包含
有限个标量。保留节点规模、完整成员和排序要求，以及后续空调用隔离断言。
不改候选代码、参考解、任务版本、限额、评分组或预声明检出项。

## Alternatives considered

- 增大内存或将 OOM 计为检出会掩盖测试资产问题，并降低验收可解释性，未采用。
- 缩小环规模或只比较长度会削弱原有资源与完整性要求，未采用。

## Consequences

起始缺陷恢复为普通断言失败，所有隐藏项产生结果。逐项比较与原数组精确比较
保持同样的成员及顺序要求，失败诊断不再需要生成巨大差异。结果仍是题目开发验收，
没有调用真实被测模型或裁判，难度与发布阈值仍待校准。

## Verification

- 固定镜像 `sha256:a101cfd83636ec92753323758f0de64d6d190cfa201fd2f8ccab837e4b9efc6a`，
  Linux、Node 24.14.1、1 CPU、512 MiB：修改前单项测试 SIGKILL。
- `pnpm container:trial --task GRAPH-04 --alternatives`：1/1 通过，starter 为
  check-failed，可用验证 24.67/50；参考和替代均 passed、50/50，隐藏项缺失数为 0。
  记录：`data/trials/2026-09-14T11-31-34-192Z`。
- `pnpm task:verify GRAPH-04`：6/6 阶段通过；记录：
  `data/task-runs/GRAPH-04/2026-09-14T11-31-57-283Z`。
- `pnpm task:mutants GRAPH-04`：3/3 有效检出，实际失败与预声明一致；记录：
  `data/task-mutations/GRAPH-04/2026-09-14T11-31-59-950Z`。
