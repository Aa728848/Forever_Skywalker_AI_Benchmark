# Agent Note: 最小独立执行器与故障分类（M1-03）

Status: implemented

## Problem

M1-02 能把候选冻结成不可变的被测对象，但还没有任何执行能力：检查在哪里跑、超时与取消如何回收、
候选崩溃与平台故障怎么区分，以及候选 stdout 里的 PASS 能不能直接当作通过，都没有可执行答案。
M1-03 要求交付最小独立执行器、资源/网络约束、可信检查结果、退出与回收，判据是参考补丁实测通过、
缺陷补丁失败，并且超时、OOM、取消和基础设施失败可区分。

本机环境已核实：没有 docker、没有 podman，WSL 未安装。因此本轮完成不依赖容器的部分，
正式容器执行记为未完成（与交接手册 §5 的处理边界一致）。

## Decision

- `packages/contracts` 新增 `ExecutionClassificationSchema`（passed / check-failed / timeout /
  memory-exceeded / cancelled / infrastructure-error）、`ExecutionArtifactSchema`、
  `ExecutionCheckSchema`、`ExecutionPhaseSchema` 与 `ExecutionResultSchema`
  （检查结论、退出原因、原始资源数据、候选哈希、证据引用）。既有协议与评分常量不变；
  只把 argv 单项上限从 200 放宽到 1000（真实 `--import` 路径超过 200，属向后兼容放宽）。
  另加 `explainExecutionResult`，校验失败时给出字段路径而不是一句不符合协议。
- 新包 `@fsa/executor`（`packages/executor`）：
  - `executeAttempt`：读取冻结 attempt → 物化受控副本（物化本身会重算摘要）→ 受信侧注入 `__checks__/`
    → 按题目包 manifest 的固定命令依次运行 public 与 hidden → 汇总每项声明的检查 →
    用协议校验结果 → 写 `execution.json`。
  - `runPhase`：只运行平台白名单命令；node 命令追加 `--max-old-space-size` 与受信的 `--import` 采样器；
    子进程环境只透传运行必需变量（不带代理与凭据）；输出写文件描述符而不是管道；
    超时与取消都会回收整棵进程树（Windows 用 `taskkill /T /F`，POSIX 用进程组 SIGKILL）。
  - `resource-sampler.mjs` 在被测进程退出时写回 `maxRSS`、用户/系统 CPU 原始值；
    被强杀时报告缺失，按 `null` 记录，不猜也不补。
  - 结论优先级：取消 > 基础设施故障 > 超时 > 内存耗尽 > 检查失败/通过。
    检查结论只来自平台自己解析的 TAP，并必须与 manifest 声明的检查 ID 对齐；对不上的记为 not-run。
  - 容器档案直接拒绝执行：本机没有容器运行时，不允许把宿主执行记成 Linux 隔离成绩。
  - 同一 attempt 的既有产物不覆盖：重复执行必须显式指定新的产物目录。

## Alternatives considered

- 用自建 worker 或构建器执行命令：题目包与执行器已能用 Node 24 原生类型剥离直接运行，不引入新的构建依赖。
- `spawnSync`：无法在运行中取消、无法边跑边采样，改用异步 `spawn`。
- 用管道采集子进程输出：受限沙盒会拒绝命名管道，且原始输出需要留存为证据，因此写文件描述符。
- 把 `--max-old-space-size` 当作内存配额：它只限制堆，峰值 RSS 可能更高；
  因此记录原始峰值 RSS 并在结果说明里写明口径，不宣称等同 cgroup 限额。
- 把 `linux-container` 档案就地降级为本地执行：违反不能把宿主执行称为隔离成绩的要求，改为拒绝。
- 只按退出码判定：候选 stdout 的 PASS 不能作为结论，改为按声明的检查 ID 对齐 TAP 结果。

## Consequences

- 本机结果为 `profile=local`、`isolation=none`：没有容器隔离、没有网络阻断，检查与被测对象同主机同用户运行，
  只能证明执行链路与故障分类，不能作为正式隔离成绩。
- cgroup 级 CPU/内存限额、网络阻断和容器内执行仍待容器环境接入；M1-03 的容器部分未完成。
- 采样器在被测进程内运行：候选若主动破坏采样，报告会缺失（按 null 记录）；高完整性需要容器外的独立观测方。
- 重复执行需要新的产物目录；M1-04 应把修复后重试建模为新的 attempt 记录。

## Verification

- `pnpm check`：exit 0。49 项 vitest（executor 7、tasks 9、runs 13、core 18、api 2）与生产构建通过。
- 真机演练（`node scripts/run.ts`，存储 `data/runs-rehearsal/`，均已忽略）：

  | 场景 | 结论 | 关键证据 |
  | --- | --- | --- |
  | 缺陷候选 | `check-failed` | public/hidden 各 exit=1，恰好 4 个声明检出项失败，峰值 RSS 约 74MB，无缺失检查 |
  | 参考补丁候选 | `passed` | `git apply` exit 0，候选摘要 0ea5dcdb…（与缺陷候选 a0f629de… 不同），两阶段 exit=0 |
  | 加载永不结算 | `timeout` | public 阶段 60103ms 被终止，hidden 未运行并记 7/9 项缺失 |
  | 同一候选 2 秒后中止 | `cancelled` | public 阶段 2085ms 被终止，hidden 未运行 |
  | 加载持续占用堆 | `memory-exceeded` | exit=134，1.2s，hidden 未运行 |
  | 命令不存在 | `infrastructure-error` | 单元测试：spawn 失败只记基础设施故障，不计候选失败 |
  | 重复执行同一 attempt | 拒绝 | 要求显式指定新的产物目录，不覆盖上次证据 |

- 进程回收：取消与超时之后检查系统进程表，没有遗留的 `--test` 子进程。
- 未完成：容器内执行、cgroup 限额与网络阻断；本机没有可用容器运行时。
