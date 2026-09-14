# Agent Note: Linux 容器边界与回收实际验收

Status: implemented

## Problem

原容器检查主要验证启动参数和本机行为，尚不能证明 Linux 内核实际应用资源限额，也不能用模拟的退出码证明真实 OOM、超时和取消能够正确分类并回收。

## Decision

新增 `pnpm container:verify` 入口，读取 `container:build` 写出的不可变镜像 ID，复用执行器的 `containerTransport`、`runPhase` 和 `classifyExecution`。该入口只执行五个固定的小型 Python 负载，不运行作答模型或裁判。

- 实测非 root 身份、根文件系统及受信检查只读、工作区和临时目录可写、网络仅回环接口且外部地址无路由。
- 读取 cgroup v2 配额并运行 CPU 负载，要求实际出现 CPU 限流；核对 96 MiB 内存上限和禁用 swap。
- 使用最多 40 次 fork 尝试核验 32 PID 上限，要求内核返回 EAGAIN 并记录限制事件；立即回收其子进程。
- 超时与取消均启动真实子进程，在执行器返回后检查专属容器已消失且子进程心跳停止。
- 有界尝试分配 256 MiB，要求 96 MiB 容器发生真实 OOM，Docker 返回 OOMKilled=true、退出码 137，并分类为 memory-exceeded。

原始脚本、命令输出、容器状态、阶段结果和总报告保存在 `data/container-acceptance/<时间戳>/`。临时工作区位于系统临时目录，删除前验证目录仍属于本次创建路径；兜底回收只针对本次执行器生成的容器名。

## Alternatives considered

- 只断言 Docker argv：不能证明守护进程与内核执行了这些参数，因此保留已有参数测试，并额外补真实验收。
- 自建 Docker 执行和回收逻辑：可能与正式执行器分叉，所以仅导出已有 transport 并允许验收传入较小 PID 上限，正常执行仍使用原默认值。
- 启动整道题作为资源压力测试：不能精确覆盖限额和回收状态，且可能把题目问题混入环境结果，所以用固定的小负载。

## Consequences

验收要求已启动的 Linux Docker 引擎、cgroup v2 和本地固定镜像。启动失败即拒绝执行，不回退到宿主。通过这些检查不能证明容器对任意恶意内核攻击的防护，也不能替代题库实跑或模型难度校准。

## Verification

- `pnpm typecheck`：通过。
- `pnpm container:verify`：退出 0，五项全部通过。原始证据目录：`data/container-acceptance/2026-09-14T11-19-20-776Z/`。
- 固定镜像：`sha256:a101cfd83636ec92753323758f0de64d6d190cfa201fd2f8ccab837e4b9efc6a`；Docker 29.7.2、Linux cgroup v2。
- 实测 UID/GID 为 1000；两处只读写入返回 EROFS；网络仅有 lo，外部连接返回 ENETUNREACH；CPU 配额 `50000 100000`，1.5 秒负载发生 15 次限流；内存上限 100663296 字节、swap 上限 0。
- PID 场景创建 30 个子进程后达到总 PID 32，上限阻止后续 fork，返回 EAGAIN 并记录 `pids.events max 1`；自身子进程全部回收。
- 超时与取消分别分类为 timeout/cancelled，容器均已删除，回收后的子进程心跳保持不变。
- 真实 OOM 场景为 OOMKilled=true、退出 137、memory-exceeded；没有把它归类为基础设施故障。五次运行的专属容器均由真实执行器完成回收，无兜底清理触发。

### Linux 质量证据链追加验收

使用系统临时目录中的一次性 Node 脚本导出 PERF-04 参考解，调用 `verifySubmission` 与 `createQualityProvider({ measurePerformance: true, env: {} })`，执行档案和镜像从 `data/container/runtime.json` 读取；明确传入空裁判环境，未读取裁判配置或调用实际模型。临时脚本和候选目录均已清理，复现脚本作为原始证据保留在 data 内。

- 原始证据：`data/container-quality/2026-09-14T11-30-21-017Z/`；`report.json` 显示全部断言通过。
- PERF-04 功能验证实际在容器执行，可用分 50/50；静态证据与专用性能负载已取得，评分模式 rehearsal，quality/total 均为 null，裁判未配置的原因有记录。
- `task-dedicated-workload` 采用两轮预热和七轮候选/参考配对，共 18 次容器负载。逐次检查冻结 manifest 的 linux-container 档案与相同 image ID、Docker 实际退出状态和删除回执，均退出 0、无 OOM，执行器完成回收。
- 每个样本实际运行 32000 事件、2000 会话、12 次迭代的 0.2.0 专用负载，完整语义检查均通过；外部阶段时间用于配对，内部诊断数据仍按诊断口径保留。
- 本次与全题库验收并行，目的是验证真实容器中的证据链，不用于性能噪声或阈值校准；`calibrated=false`，没有发布正式性能或模型成绩。
