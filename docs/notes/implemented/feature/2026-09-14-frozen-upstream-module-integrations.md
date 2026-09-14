# Agent Note: 固定原始源码的 Harness、订阅和 Trading 集成题

Status: implemented

## Problem

原仓库集成题此前只有设计目录，不能通过另写同名模型替代真实项目行为。固定源提交也含真实缺陷：重连零前缀仍重建一个片段、注销后刷新复活凭据，以及写盘前先发布账本内存状态。

## Decision

- INT-HARNESS 保留固定 deepseek-harness 提交的 8 个原始文件，包括 ClientAssistantStream、压缩流、BlockAssembler、message 与值/品牌/crypto 依赖及许可证。验证重连前缀、稠密帧、真实组装、结算恢复和 100000 增量。
- INT-SUB 保留固定 subscription 提交的 OAuth、TokenStore、callback、watchdog、compat、contracts 与许可证，并附固定 harness 提交的真实 timeout、error、完整 index 和许可证，共 11 份原始文件。只替代外部 OAuth HTTP 和流源，业务认证、真实 AbortSignal 与看门狗代码均执行。完整 index 的 LlmError 声明由受信加载器按源码声明边界定向加载，避免初始化无关服务；该过程与依赖摘要在题面和 SOURCE.json 明示。
- INT-TRADING 保留固定 trading 提交的真实任务账本、协议、调度、TTL 缓存及原许可证，共 5 文件。用合成报价驱动原任务动作，检查磁盘失败、请求重试、重启、目录锁、执行历史和缓存上限。题目明确是行情触发任务账本的模块子集，不包含券商接入或真实交易。
- 每题的 SOURCE.json 包含原始路径、固定提交和 SHA-256。除了明示的缺陷注入，所有文件哈希均与 git show 的原始内容一致。来源仓库保持只读。
- newtask.ts 增加按 track 路由、显式固定命令和 Python 运行支持，仍先拒绝已有资产、三向通过后才推进 fixture-ready。创建前要求五组均有正权重检查且至少一个预声明缺陷检出项；实跑与预期不同直接回滚，删除了依观察结果反向修改 defectDetectors 的逻辑。

## Alternatives considered

未采用当前 HEAD、简化业务替身或完整宿主应用启动来冒充集成。选用可离线运行的真实模块子集，以原接口验证跨模块行为；原始 TypeScript 由 Node 内置转换器和显式依赖映射运行，不为套用平台的编译配置而修改来源文件。

## Consequences

三个集成题各有六个覆盖五组评分的检查，参考补丁与替代实现完整通过。基线结果如实记录原上游缺陷；不把失败基线包装为正常应用全量通过，也不把宿主执行冒充容器执行。原许可证随源码提供，尤其保留 trading 的非商业许可文本。

## Verification

- node scripts/task.ts verify INT-HARNESS、INT-SUB、INT-TRADING：全部六阶段通过；隐藏资产未导出。
- 非缺陷注入文件逐一重算 SHA-256，与冻结来源完全一致。
- 在系统临时副本恢复所有未修改上游源码，重新跑公开/隐藏基线，所有检查均运行、无缺失项。原始结果保存于 data/source-baselines/2026-09-14T10-18-51-802Z/。
- 原始 Harness 仅零前缀检查失败；原始订阅模块三项注销/在途写入/释放检查失败；原始 Trading 两项磁盘失败状态检查失败。参考与替代已修复这些实际缺陷。
- 核心十题在五组评分补齐后重新三向验证通过；平台总回归和原仓库其余集成题由主代理统一记录。
- 最新生成器实际创建 INT-PY 并通过全部六阶段；catalog 最终为 55/55 fixture-ready。平台 pnpm typecheck 在分离原仓库集成源码的编译边界后通过。
