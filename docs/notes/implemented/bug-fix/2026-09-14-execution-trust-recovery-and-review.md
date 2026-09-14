# Agent Note: 修复执行证据、容器回收与重复提交恢复

Status: implemented

## Problem

已有链路会执行候选修改的公开检查，Node 无进程隔离时候选可打印顶层 TAP；异常退出与重复检查行可能被判通过。容器退出码 134/137/139 被误记成基础设施故障，超时只终止 docker 客户端；结果把容器档案写成本机，且把本机网络写为禁止。崩溃后的 execution-2 结果不会被查询复用，冻结目录提交而索引尚未提交的窗口无法恢复。同键不同执行环境也会复用旧成绩。静态评分扫描的是运行后可修改的工作区。

## Decision

- 从平台恢复公开检查；隐藏检查在本机隐藏阶段前重新注入；Node 检查采用测试进程隔离，把候选 stdout 与验收行区分。重复 ID 判失败，非零退出不能判通过。
- 容器使用固定名称及禁止拉取，增加非 root 身份、只读根文件系统、只读检查、禁提权与可写临时目录；终止容器本体、读取 OOMKilled 后删除容器。只把 125/126/127 认作 docker 启动故障。支持 repo@digest 与经 inspect.Id 校验的本地不可变 image ID。
- 结果记录实际 profile/network 及容器资源限额。本机结果使用 local 模式，演练与正式模式由评分核心的发布条件区分。
- 查询最近完成的 execution-N，execution.json 原子提交；合并同一进程内的并发完成事件。重启时恢复已提交冻结目录的索引，校验物化后的副本摘要，拒绝同键换提交者或执行环境。
- 静态分析扫描冻结源码。qualityProvider 在执行后获取真实质量证据，失败时保留可用检查与待定质量分。reviewCompletedAttempt 复用并校验阶段证据，在新的 execution-N 保存补评分数，保留旧分数与事件。

## Alternatives considered

未把容器缺失时的宿主执行替代成容器结果；未用调整超时掩盖 Windows 进程终止权限问题。未覆写原执行目录完成补评，因为这会丢失审计历史。没有重写所有题目的测试驱动成跨进程 RPC 验证器，该工作会改变任务接口与实施范围。

## Consequences

针对已确认缺陷的回归闭环已通过。当前 Node 进程隔离与只读资产阻止直接替换测试/打印通过行；隐藏测试依然需要在容器内读取候选代码，不能据此宣称完全抵抗恶意运行时代码篡改。资源采样器仍运行在被测进程中，只作为诊断样本；不能独立充当可信性能客观分。控制面依然采用单服务进程写入，未宣称多主节点一致性。

## Verification

- `pnpm typecheck`：通过。
- `pnpm exec vitest run packages/tasks/src/tasks.test.ts packages/runs/src/runs.test.ts packages/executor/src/container.test.ts packages/executor/src/executor.test.ts`：四文件 51/51 通过，耗时 4.73 秒。使用完整进程权限执行真实子进程，包含超时、OOM、取消、预取消、TAP 伪造、公开检查替换、并发幂等、崩溃恢复及追加补评。
- 真实 Linux 容器实跑：本次记录时尚无可用容器运行时，不计为通过；根代理正在配置环境。容器参数与拒绝路径的测试不替代隔离实跑。
