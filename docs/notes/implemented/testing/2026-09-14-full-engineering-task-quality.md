# Agent Note: 全题库工程场景审查与使用入口收尾

Status: implemented

## Problem

用户要求题目能区分大模型的实际工程开发水平，并改善不合适的题。前一轮只强化API-04/GRAPH-04；若直接把其余单点修复称为极难，或把参考实现通过当作模型鉴别力，结论都缺证据。用户还需要理解Docker、DSH、网页的启动关系，以及同名模型的供应商归属。

## Decision

逐题复核55题的公开契约、起始代码、参考与结构不同的替代、隐藏检查和真实来源。按故障场景和相互作用的不变量判断，保留基础门槛题，不用文件数或行数制造难度。改善32题、澄清4题、保留19题，发布逐题版本与理由的Markdown和JSON矩阵。所有题继续fixture-ready，真实模型区分度保持未校准。

各领域记录：

- [前端、状态与生命周期](2026-09-14-frontend-state-engineering-quality.md)
- [后端、缓存、图与性能](2026-09-14-backend-cache-graph-performance-quality.md)
- [LSP、边界与并发](2026-09-14-lsp-boundary-concurrency-quality.md)
- [CWT、Trading、Python集成](2026-09-14-integrated-cwt-trading-python-mutants.md)
- [Verifier、Web集成](2026-09-14-verifier-web-integration-mutations.md)

根任务升级INT-HARNESS至0.2.0：原参考先完整展开压缩流再截取，虽然输出对，却无法证明有界前缀工作量。明确持久边界已验证压缩流，前缀读取只接触所需payload；参考裁剪压缩记录后调用原展开器，替代用生成器逐记录处理。隐藏检查用真实成员访问探针验证不读尾部、零前缀不读取记录；混合text/reasoning/tool-call/raw记录在24组确定性输入上与独立全展开oracle比较，并验证错帧不能推进游标。原来源副本与哈希保持不变。

INT-SUB至0.2.0增加延迟TokenStore读取期间的注销/dispose隔离，以及预取消不创建流源。独立复核进一步发现公开await交接窗口，修复和真实微任务复现见 [认证入口交接Note](../bug-fix/2026-09-14-oauth-public-await-handoff.md)。参考和替代分别用代际与AbortSignal身份；不把内部等待结束后捕获的新身份误当成原操作身份。

新增 [启动指南](../../../quick-start.md)，明确全部命令在评测项目PowerShell执行。DSH自动比较自行启动SDK，网页仅用于浏览目录与手工提交记录；其他编程AI可使用export/submit。`--all`选择全部已有题包，与`--tasks`互斥。提交者字段补供应商ID；设置和报告原本就保留provider/model，两个供应商同名模型不会合并为同一来源。额外供应商的思考参数问题由独立使用审查发现，新增真正省略参数的default模式，见 [修复Note](../bug-fix/2026-09-14-dsh-provider-default-reasoning.md)。

严格类型检查发现Promise.withResolvers与ES2023 lib不符，将lib提高到受支持Node24已有的ES2024；target仍为ES2023，strict/noUnused保持。各领域仅清理本轮真实类型错误并重新验证对应补丁。

## Alternatives considered

没有把55题全部改成大项目，也没有为了数量添加浅层检查；简单题作为基础退化门槛仍有价值。没有用更多事件数替代工程复杂度；新性能负载直接经过增量索引和持久流式投影主路径。没有以编译错误或缺测冒充反例检出，也没有在观察结果后自动调整目标。没有修改七个来源仓库或启动用户尚未授权启动的真实模型作答校准。

## Consequences

新版高难题覆盖跨代资源所有权、事务提交/崩溃恢复、多资源公平交接、异步插件回滚、共享图重写及有界流式处理。已有与新增反例共83个，均有对应版本及补丁哈希的有效检出记录。它们是作者选定的错误变体，不是83次AI作答；公开仓库和候选可访问的隐藏检查也不构成完全防泄漏/防篡改系统。

默认CACHE-02只检查工作流；全题库模式可用于后续统一模型、预设、预算和裁判的真实实验。未测到的质量维度和总分仍为null，未将开发验收提升为正式成绩。

## Verification

- INT-HARNESS三向六阶段：`data/task-runs/INT-HARNESS/2026-09-14T13-28-26-307Z`；3/3反例：`data/task-mutations/INT-HARNESS/2026-09-14T13-29-31-204Z`。
- INT-SUB最新三向六阶段和3/3反例分别为 `data/task-runs/INT-SUB/2026-09-14T13-57-55-445Z`、`data/task-mutations/INT-SUB/2026-09-14T13-57-56-970Z`。
- 83个反例的逐题证据路径与实际补丁哈希匹配结果见 [机器矩阵](../../../../catalog/task-quality-audit.json)。编译/启动失败、超时或缺测不计为有效检出。
- `pnpm dsh:compare --all --provider gateway-a --model same-model --preset standard --reasoning high --check`预检显示55次；供应商认证与模型能力未在预检中调用验证。`--all --tasks CACHE-02`明确拒绝并退出1。
- 新default模式的同样55题预检通过，最终 `pnpm check` 202项测试、严格类型、目录一致性和生产构建通过，本轮端到端2项通过。
- 固定Linux、最终平台与专用性能负载的实际验收见 [本轮整体验收](../../../trials/2026-09-14-full-quality-linux-validation.md)。初始平台检查的实际类型错误已修复；Docker首次未启动导致全量命令在候选执行前停止，启动现有引擎后分两批完成，不重建镜像。

本轮真实模型/裁判调用0，Windows未重启，来源仓库只读；作者临时脚本清理，运行产物保存在已忽略data/。
