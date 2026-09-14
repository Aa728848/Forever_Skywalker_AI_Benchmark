# Agent Note: CWT、Trading 与 Python 来源集成题的近似错误修复验收

Status: implemented

## Problem

集成题包含真实来源模块，但正确基线与一个起始缺陷对照，无法单独证明测试会拒绝看似可用的局部修复。用户要求审查整个题库的实际工程区分能力，本批针对 INT-CWT、INT-TRADING、INT-PY 补充相互不同的错误修复反例。

## Decision

- INT-CWT 保留原模块范围，题目升 0.1.1：原检查未直接覆盖“准备旧版本后发生新版本编辑”的晚发布，也未单独检验同版本通知导致的诊断 admission 更新。补两项已有公开协议内的隐藏检查；参考及来源模块没有修改。四个反例分别仅验版本、仅验代际、忽略 admission、锁内通知。
- INT-PY 保留真实概率提取、线程池、缓存和 PPT 管线，题目升 0.1.1：方向缓存输入和期望原来均调用候选 cache_key，改为独立固定磁盘键并验证双向 directed_reward。四个反例覆盖方向键合并、失败平局持久化、rep 槽位未还原、标量别名概率相加。
- INT-TRADING 的原检查已能拒绝四种有意义反例：内存先于 rename 发布、请求键缺指纹、通知早于提交、启动取消已有 session 的执行。保留版本 0.1.0，只新增 grader 反例资产。

所有反例从正确参考应用单一错误变更，先声明目标检查，再运行完整检查；额外交叉检出保留，不根据观察结果改写目标。七个源仓库、许可证、SOURCE/PROVENANCE 及 vendored 来源文件未修改。

## Alternatives considered

- 重新编写三道集成题：真实模块链路已经有工程价值，最小范围应补可信检验与反例，不为了文件数量重写。
- 仅把起始缺陷命名为多个 mutant：不能验证多个不变量，本批每项修改不同的行为边界。
- 仅直接断言缓存键字符串：改为经过真实 directed_reward 消费磁盘缓存，验证方向语义的后果。

## Consequences

本批 12/12 个近似错误修复被预声明目标有效检出，不能推广为穷尽错误或真实模型难度校准。INT-CWT/INT-PY 版本变化后旧成绩不可混合；INT-TRADING 只增加作者端验收证据，无候选行为变化。

## Verification

- `node scripts/task.ts verify INT-CWT`：六阶段通过，`data/task-runs/INT-CWT/2026-09-14T13-43-55-762Z`。
- `node scripts/mutants.ts INT-CWT`：4/4，`data/task-mutations/INT-CWT/2026-09-14T13-44-12-199Z`。
- `node scripts/task.ts verify INT-PY`：六阶段通过，`data/task-runs/INT-PY/2026-09-14T13-44-39-969Z`。
- `node scripts/mutants.ts INT-PY`：4/4，`data/task-mutations/INT-PY/2026-09-14T13-44-40-776Z`。
- `node scripts/mutants.ts INT-TRADING`：参考基线和 4/4 反例通过，`data/task-mutations/INT-TRADING/2026-09-14T13-44-42-157Z`。

以上使用本机真实 .NET/F#、Python 线程池与 Node/文件账本，不调用模型。整体检查和 Linux 容器回归由本轮根任务统一执行并记录。
