# Agent Note: 容器档案与固定镜像（M1-03 收尾）

Status: implemented

## Problem

M1-03 此前对 `linux-container` 档案一律直接拒绝：本机没有容器运行时，而平台也还没有容器执行路径。
这次把容器路径**实现完整**，让剩下的唯一缺口变成“有一台可用的容器运行时并预载固定镜像”。

## Decision

- 协议：`ExecutionManifest.environment` 增加 `image`（镜像引用）；执行结果的 `environment` 增加
  `containerRuntime`（实际使用的运行时与版本）与 `image`（实际使用的 `镜像@digest`）。
- 冻结控制面：`submit` 接受 `profile` / `image` / `imageDigest`；`linux-container` 档案必须**同时**固定镜像引用与
  digest，否则提交阶段就被拒绝，避免出现“声称容器执行但没有镜像”的记录。
- 新模块 `packages/executor/src/container.ts`：
  - `containerImageReference`：只接受 `sha256:` + 64 位 hex，拼成 `镜像@digest`。
  - `probeContainerRuntime`：`docker version --format {{.Server.Version}}`，失败即抛 `InfrastructureUnavailableError`。
  - `requirePinnedImage`：`docker image inspect 镜像@digest`，本地没有就直接失败——**执行期不拉取镜像**。
  - `buildContainerInvocation`：`docker run --rm --network none --cpus <n> --memory <m>m --memory-swap <m>m
    --pids-limit 512 --workdir /work -v <工作区>:/work -v <隐藏检查>:/work/__checks__:ro
    -v <采样器>:/opt/fsa/resource-sampler.mjs:ro --env FSA_RESOURCE_REPORT=/work/<阶段>.resources.json 镜像@digest <argv>`。
  - `buildContainerArgv`：node 命令在容器里用镜像自带的 `node`（而不是宿主路径），并注入只读采样器与堆上限；
    非 node 命令（F# 的 `dotnet fsi`）按声明原样执行。
  - `isContainerRuntimeFailure`：把 docker 自身的失败码 125/126/127 归为基础设施故障。
- 执行器：引入 `PhaseTransport`，本地档案与容器档案共用同一个阶段运行器（同样有超时、取消、进程树回收、
  证据哈希与资源采样）；容器档案额外记录 `isolation=container` 与镜像信息，并且在分类时只对容器阶段应用
  docker 失败码规则。隐藏检查以**只读**方式挂载在 `/work/__checks__`，不再复制进候选树（本地档案仍复制）。
- 入口：`bench submit --profile linux-container --image <引用> --image-digest sha256:...`；
  运行 API 用 `BENCH_PROFILE` / `BENCH_IMAGE` / `BENCH_IMAGE_DIGEST` 统一配置，`/api/health` 报告 `runProfile` 与
  `isolatedExecution`；试跑脚本 `scripts/trial.ts` 也读同一组环境变量，容器可用后一条命令即可产出容器口径报告。
- 顺带修掉一个真实缺陷：`data/` 下的 attempt 目录与 `index.json` 在 Windows 上偶发 `rename` EPERM
  （杀毒/索引服务短暂占用），出现时会让一次试跑丢掉一道题。现在对 `EPERM/EACCES/EBUSY/ENOTEMPTY` 做有限退避重试。

## Alternatives considered

- 执行期 `docker pull`：破坏“依赖预先安装并锁定”的前提，也让同一 digest 的结果依赖网络，改为本地 inspect 失败即拒绝。
- 长驻容器 + `docker exec`：多一层生命周期管理，收益只是省一次 `run` 启动开销，未采用。
- 把隐藏检查复制进候选树（沿用本地档案做法）：候选可以改写它们；容器档案改为只读挂载，
  位置仍在 `/work/__checks__`，因此检查里的相对路径（如 F# 的 `#load "../starter/src/..."`）在两种档案下都成立。
- 现在就加 `--read-only` 根文件系统：`dotnet fsi` 与 node 可能需要可写临时目录，未在真实容器里验证前不加，
  列为容器可用后的第一批加固项（配合 `--tmpfs /tmp`）。

## Consequences

- 容器路径的每一环都有确定行为与单元测试，但**没有在真实容器里跑过一次**：这是当前唯一剩余的工作。
- 候选在容器内仍然可以读取隐藏检查（只读挂载只防改写，不防读取）。物理保密需要容器外的独立验证进程，
  这一点在结果说明里明确写出，不会宣称“隐藏资产不可见”。
- 镜像必须自带题目所需的运行时（node 命令用 node 镜像，LSP-01/THR-03 需要 .NET 10 镜像），
  并且必须按 digest 预载到执行机；这条要求现在写进了结果说明与交接手册。
- Windows 上用 `--volume <宿主路径>:<容器路径>` 挂载；已在单元测试里覆盖 `C:\...` 形式，真实 Docker Desktop 行为待实跑确认。

## Verification

- `packages/executor/src/container.test.ts`（8 项）：镜像引用格式、docker 失败码识别、`--network none`、
  `--cpus/--memory/--memory-swap/--pids-limit`、工作区可写与隐藏检查只读挂载、只读采样器与容器内 `node`、
  非 node 命令原样、容器环境不透传代理与凭据、运行时缺失与镜像缺失的两种拒绝。
- 真机演练（`node scripts/run.ts`）：以 `--profile linux-container --image fsa-bench-node24 --image-digest sha256:bbb…` 提交
  成功，执行 manifest 记录 `profile=linux-container image=fsa-bench-node24 digest=sha256:bbb… network=False`；
  执行阶段以 `容器运行时不可用（docker version 退出码 null）` 退出码 1 拒绝，没有退回宿主执行；
  缺少镜像引用时提交直接被拒。
- `node scripts/trial.ts` 连续三次 8/8（含 rename 重试修复后的两次），`pnpm check` exit 0（61 项 vitest）。

## 容器可用后的最后一步（runbook）

1. 准备镜像：镜像内需有题目运行时（node 24 / .NET 10），并 `docker pull` 后用 `docker image inspect --format '{{index .RepoDigests 0}}'`
   取得 manifest digest。
2. 自检：`docker version` 能连上守护进程；`docker image inspect <镜像>@<digest>` 退出码为 0。
3. 单题验收：`pnpm bench submit CACHE-02 <候选> --key container-1 --profile linux-container --image <镜像> --image-digest <digest>`，
  缺陷候选应为 `check-failed`、参考补丁候选应为 `passed`，结果里 `isolation` 必须是 `container`。
4. 全量试跑：`$env:BENCH_PROFILE='linux-container'; $env:BENCH_IMAGE='<镜像>'; $env:BENCH_IMAGE_DIGEST='<digest>'; pnpm trial`，
   期望 8/8，且报告里的 `isolation` 为 `container`。
5. 加固项：按需补 `--read-only` + `--tmpfs /tmp`、非 root 执行身份、容器内基准镜像摘要记录。

