# Agent Note: Linux真实执行记录与三种实现验收

Status: implemented

## Problem

用户完成重启后需要继续配置已授权的Linux环境。此前只有宿主验收，不能确认Docker命令、语言运行时、资源限制和完整题包在容器中工作。真实首跑发现包装后的Docker参数超过原执行记录32项上限，另有GRAPH-04测试侧差异诊断OOM。

## Decision

启动Docker Desktop并确认Linux/虚拟化状态，构建官方基础镜像固定digest的完整运行镜像，实测四个运行时版本，保存镜像与主机元数据，并自动更新项目.env的执行档案。裁判配置不变且本轮不调用模型。

仅将ExecutionPhase.argv记录上限改为128，declaredCommand仍32，并以真实构造的Docker命令验证协议；不削减挂载、资源或隔离参数。导出既有containerTransport供独立小负载复用，允许更小PID限制以实际验收内核边界，不另造执行器。

trial新增可选--alternatives，同一固定环境验收缺陷/参考/替代；默认两种实现保持原接口。容器脚本仅在引擎未连接时显示重启提示，候选或题目失败直接保留其实际原因。

全量55题先得到54/55；GRAPH-04定位为大数组deepEqual诊断耗尽内存，按完整语义拆为长度与逐项断言后单题复跑通过。失败记录、修复记录和最终逐题来源同时保留，不改写初次报告。修复没有修改原来源仓库、公开契约或扩大题目资源预算。

## Alternatives considered

- 仅安装Docker或检查version即宣告完成：不足以证明实际语言/容器/内核边界，补5项真实边界、55题及专用性能链。
- 从Docker argv移除隔离选项以适配32项：会损害执行边界，因此只修正记录字段。
- 把OOM当作正确检出、提高题目内存或缩小图规模：会掩盖测试问题，改用保持完整比较且诊断有界的断言。
- 在首轮全局协议错误后继续盲跑：停止已定位的本次进程及专属容器，清理其临时目录，修复后重新执行并保留证据。

## Consequences

Linux环境已实际就绪，未校准成绩继续rehearsal；真实模型与裁判仍暂停。当前固定镜像不可与以后重建镜像混作同一性能环境。通过资源测试不代表容器能防护任意恶意内核行为，隐藏检查的同进程可读边界没有变化。

## Verification

pnpm container:build/status通过；container:verify五项真实边界通过；最终55题覆盖中参考/替代110次均50/50，55个缺陷准确检出；PERF-04性能链18次固定容器测量和回收通过，模型调用0。pnpm check为173项测试及类型/目录/构建通过，pnpm test:e2e为2项通过。实际API健康探测确认Linux档案/隔离可用。所有原始路径、修复复跑与镜像ID见docs/trials/2026-09-14-linux-container-validation.md。
