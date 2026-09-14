# Agent Note: 安装 Windows Linux 容器前置环境

Status: implemented

## Problem

用户要求继续完成项目，并授权配置 Linux 容器。此前没有 Docker/Podman，VirtualMachinePlatform 未启用，交接文档仅记录环境阻塞。

## Decision

核对了管理员权限与硬件虚拟化支持。按用户授权启用 VirtualMachinePlatform，使用 NoRestart 避免中断正在运行的工作；经 winget 安装微软 WSL 2.7.13 和 Docker Desktop 4.90.0，安装器校验通过，Docker 使用 WSL 2 后端。

新增 `containers/runtime.Dockerfile` 和 `scripts/container.ts`，提供实际环境探测、基础镜像摘要记录、合并运行时镜像构建及容器试跑入口。准备操作在执行期之外完成，最终运行固定到不可变 image ID。

## Alternatives considered

- 保持环境缺失并只补文档：用户已经授权配置，因而实际安装前置组件。
- 为避免重启另建软件模拟虚拟机：会扩大维护范围，已有硬件与 Windows 支持 WSL 2，不另引入第二套虚拟化方案。
- 自动重启电脑：会中断用户及本次并行工作，仅记录必要重启，不在未获明确重启指令时执行。
- 以本机执行替代容器验收：不符合已确认环境要求，未采用。

## Consequences

前置软件已经安装，但 Windows 明确要求重启。镜像构建和容器内试跑必须在重启、Docker 引擎启动后完成；没有把这些未运行项登记为通过。

## Verification

- 硬件检查：AMD Ryzen 7 9800X3D，固件虚拟化与二级地址转换可用。
- `Enable-WindowsOptionalFeature ... -NoRestart` 返回 `RestartNeeded: true`。
- winget 对两个安装包均报告哈希验证成功、安装成功。
- Docker Desktop 文件版本为 4.90.0.238679；WSL 版本输出为 2.7.13.0。
- Docker 服务端探测仍失败：named pipe 不存在。Windows 重启、镜像构建、Linux 容器检查未执行。
- 后续具体步骤见 `docs/container-setup.md`。
