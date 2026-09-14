# Linux容器配置与实际验收

日期：2026-09-14。用户已自行重启Windows，HypervisorPresent=true。Docker Desktop 4.90.0.238679 / Engine29.7.2使用Linux、cgroup v2和WSL2内核6.18.33.2；引擎可见16 CPU及24716660736字节内存。候选使用各题manifest的更小配额。

## 固定环境

镜像：`sha256:a101cfd83636ec92753323758f0de64d6d190cfa201fd2f8ccab837e4b9efc6a`。

基础镜像分别固定为Node `sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c` 和 .NET `sha256:ea8bde36c11b6e7eec2656d0e59101d4462f6bd630730f2c8201ed0572b295d5`。镜像实际版本：Node24.14.1、.NET10.0.301、Python3.11.2、Chromium152.0.7977.82。

记录：[runtime.json](../../data/container/runtime.json)、[image-inspect.json](../../data/container/image-inspect.json)、[host-runtime.json](../../data/container/host-runtime.json)。本项目.env已写入Linux档案与固定镜像，原裁判/令牌字段保留。API实际健康探测返回runProfile=linux-container、isolatedExecution=true、judgeConfigured=false。

## 实际验收

| 范围 | 结果 | 原始证据 |
| --- | --- | --- |
| 非root、只读、网络和CPU | UID/GID1000；写根/检查目录得到EROFS；仅lo接口且外部连接ENETUNREACH；0.5CPU负载实际发生15次限流 | [边界报告](../../data/container-acceptance/2026-09-14T11-19-20-776Z/report.json) |
| 内存与PID | 96MiB、swap0；总32PID时fork返回EAGAIN | 同上 |
| 超时/取消回收 | 分别正确分类，容器消失且子进程心跳停止，无兜底清理触发 | 同上 |
| OOM | 实际OOMKilled=true、退出137、memory-exceeded | 同上 |
| 55题全量，含替代实现 | 首轮54/55；全部参考/替代已50/50，GRAPH-04负例暴露测试侧OOM | [全量报告](../../data/trials/2026-09-14T11-22-48-314Z/report.json) |
| GRAPH-04修复复跑 | 1/1通过，缺陷精确检出24.67/50，参考/替代各50/50 | [单题报告](../../data/trials/2026-09-14T11-31-34-192Z/report.json) |
| 最终逐题覆盖 | 55/55；110个参考/替代结果均50/50，55个起始缺陷精确检出 | [逐题来源汇总](../../data/container/validation.json) |
| PERF-04真实性能链 | 2轮预热+7对，共18次专用容器负载，全部退出0并回收；模型调用0 | [质量链报告](../../data/container-quality/2026-09-14T11-30-21-017Z/report.json) |
| 平台回归 | pnpm check：173测试、类型、55题目录和构建通过；pnpm test:e2e：2项通过 | 对应开发命令已执行 |

质量链结果为functional50、mode=rehearsal、quality/total=null。配对运行用于验证容器测量链，未以并行开发机器上的比值校准性能阈值。

## 暴露并修正的问题

1. 执行记录把Docker包装参数误限为32项，导致已经执行的结果不能保存。已仅将实际argv上限扩到128，题目原始命令仍限32；增加实际构造命令的协议回归。第一次试跑 `data/trials/2026-09-14T11-19-22-840Z/` 因此中断，专属进程/容器和临时目录已清理，原始输出保留，不能作为完成成绩。
2. GRAPH-04负例返回两项，测试直接与20,000项数组做deepEqual，诊断差异自身耗尽512MiB。改为长度检查后逐项精确比较，保留规模、成员、顺序和调用隔离语义；没有放宽预声明缺陷或提高内存预算。容器复跑通过，本机三向6/6、近似错误修复3/3也通过。
3. 容器脚本在候选检查失败时仍附带“可能需要重启”的提示，现仅在引擎未连接成功时给出该提示。

本轮最终只读检查没有残留fsa命名评测容器。Docker Desktop保持运行供后续使用，没有执行全局prune或修改其他容器。

## 成绩边界

本次是执行环境和题目包验收，未启动任何真实模型作答或裁判。全部题仍为fixture-ready，正式成绩和难度/静态/性能校准未完成；隐藏检查运行时可被候选读取，同进程验证不能据此宣传为完全防篡改。
