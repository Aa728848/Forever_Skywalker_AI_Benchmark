# Linux 容器环境

用户已于2026-09-14重启Windows，虚拟化生效。Docker Desktop 4.90.0.238679 / Engine 29.7.2 已运行Linux引擎，WSL 2.7.13可用。固定镜像已构建并配置进本项目.env，真实网络/资源/回收验收5项通过；题库容器验收见本轮交接记录。

55道题的参考与替代110次均取得50/50，55个起始缺陷准确检出；全量中的GRAPH-04测试侧OOM已修复并单题复跑通过。PERF-04的18次专用容器负载也通过，未调用模型。详细记录见 [Linux验收报告](trials/2026-09-14-linux-container-validation.md)。

## 已固定的运行环境

镜像ID：`sha256:a101cfd83636ec92753323758f0de64d6d190cfa201fd2f8ccab837e4b9efc6a`。完整记录在 `data/container/runtime.json`。

| 运行时 | 镜像内实际版本 |
| --- | --- |
| Node.js | v24.14.1 |
| .NET SDK / F# | 10.0.301 |
| Python | 3.11.2 |
| Chromium | 152.0.7977.82，Debian 12 |

## 常规执行

在普通用户的PowerShell中执行；只有Docker未运行时才需要start：

```powershell
Set-Location -LiteralPath 'C:\Users\A\Documents\ChatGPT\Forever_Skywalker_AI_Benchmark'
& "$env:ProgramFiles\Docker\Docker\resources\bin\docker.exe" desktop start --detach
pnpm container:status
pnpm container:verify
pnpm container:trial --all --alternatives
```

容器引擎尚未就绪时 `container:status` 会失败；待 Docker Desktop 启动完成后再次执行即可。脚本不会偷偷改用宿主执行。

创建或主动更新运行镜像时才执行 `pnpm container:build`。它拉取Node24.14.1和.NET SDK10.0.301官方镜像、记录manifest digest，再构建完整运行镜像。常规执行复用已保存的不可变image ID，运行阶段不下载镜像或依赖。`--alternatives`使题库试跑同时验证缺陷、参考及不同结构替代实现，保留每种结果。

基础镜像相同不代表再次构建时 apt 软件包完全相同；因此以最终 image ID 为执行环境的固定标识。需要跨机器复用时应导出并导入同一个镜像，不能重建后继续沿用旧环境标识。

## 单次作答使用容器

构建成功后脚本会自动将真实 image/imageDigest 和 linux-container 档案写入本项目 `.env`，保留原来的提交令牌及裁判配置。手动核对时，三个字段应为：

```dotenv
BENCH_PROFILE=linux-container
BENCH_IMAGE=sha256:a101cfd83636ec92753323758f0de64d6d190cfa201fd2f8ccab837e4b9efc6a
BENCH_IMAGE_DIGEST=sha256:a101cfd83636ec92753323758f0de64d6d190cfa201fd2f8ccab837e4b9efc6a
```

以上为本次实际镜像；重新构建后以runtime.json的新记录为准。`pnpm container:trial`自动读取真实配置，批量试跑不需要手抄摘要。

CLI 提交可以显式传 `--profile linux-container --image <实际镜像ID> --image-digest <同一ID>`。API 通过上述环境变量选择档案；提交根目录和令牌见根目录 `.env.example`。

## 验收证据

`pnpm container:verify`已在实际镜像上通过5项边界验收，原始证据在 `data/container-acceptance/2026-09-14T11-19-20-776Z/`：UID/GID1000、根和检查目录写入EROFS、仅lo接口且外部连接ENETUNREACH、CPU实际限流、96MiB内存/swap0、32PID内核拦截、超时/取消后容器消失且子进程心跳停止，以及真实OOMKilled=true/退出137。该小负载的限额用于精确验证执行器；正式题目仍使用自己的manifest预算。

- `docker version` 必须连接真实服务端，`docker info` 的 OSType 必须为 linux。
- 镜像内四个运行时的版本检查必须通过，并保存最终镜像 ID。
- 缺陷候选应被声明检查拦住，参考与替代实现应通过。
- 每条执行结果必须有 `isolation=container`、实际运行时与镜像信息。
- 超时与取消必须回收容器本体；不能仅结束 Docker CLI。
- 样本、命令、退出原因与文件摘要保留在 `data/` 的运行档案。
- 即使容器实跑通过，未经题目/静态/性能校准及独立评审的结果仍不能标为正式成绩。

候选执行容器采用网络关闭、CPU/内存/PID 上限、只读根文件系统与检查挂载、非 root 身份、临时可写目录和降权配置。隐藏检查在运行时仍可能被候选代码读取；当前不能宣称它们在同一进程内物理保密。
