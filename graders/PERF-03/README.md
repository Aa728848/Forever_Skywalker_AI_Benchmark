# PERF-03 受信资产

来源：deepseek-harness/benchmarks/support/calibration.ts、deepseek-harness/benchmarks/active-stream-reconnect/reconnect.bench.client.ts、dsh-trading/packages/knowledge/test/graph.test.ts。

公开检查覆盖主要契约，隐藏检查改变输入规模、边界与交错；不引入题面之外的要求。参考与替代实现使用不同的数据组织或控制流程。

使用 node scripts/task.ts verify PERF-03 运行缺陷、参考补丁与替代实现的公开/隐藏六阶段检查。受信资产不向候选导出。

0.2.0 增加 GraphIndex：批次局部读取、失败事务、未解析依赖创建/删除/重建与独立编辑 oracle。`pnpm task:mutants PERF-03` 检出旧反向边、丢失未解析边、确认前推进代际三个近似修复。

专用 `benchmark.ts` / `benchmark-policy.json` 衡量新增索引主路径：3,500 节点、240 次局部修改、30 次目标创建及统计查询；受信 reader 总调用固定为 3,770。参考和候选由平台在同一固定环境交替预热 2 轮、测量 7 对，内部时间仅诊断，计时阈值尚未校准。
