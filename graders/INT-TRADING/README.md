# INT-TRADING 受信验证

本题保留 dsh-trading 固定提交的真实 TasksLedger、tasks-protocol、tasks-schedule 和 TtlCache。使用合成报价驱动任务动作，再验证缓存过期、动作协议、真实磁盘账本和重启恢复的一致性；这是行情触发任务账本的模块集成，未包含券商接入或真实交易。

修复 starter/packages/client-ui-trading/src/tasks/ledger.ts：任意写盘失败时内存快照/revision/幂等键及订阅通知不得先行，旧文件必须保持；同请求重试成功后只出现一条任务。保留原类公共API、同键异载荷冲突、目录锁、调度计算、未创建会话的启动中断取消、有会话的在途执行保留、执行历史上限等行为。不得更改其它源模块或许可证。

SOURCE.json记录固定提交和原始源码摘要；参考补丁、替代实现和隐藏检查留在受信侧。

缺陷来源：固定上游版本中的真实缺陷：TasksLedger.commit 在 fsync/rename 确认之前更新 this.document，写失败留下幽灵任务与已消费的幂等键。参考改为确认后发布，替代采用失败回滚。

全部检查均运行真实源模块。运行 node scripts/task.ts verify INT-TRADING 验证三向对照。
# 近似错误修复验证

保留 0.1.0 题面与原模块集成范围。新增四个受信反例：内存在 rename 前发布、请求去重缺失指纹、磁盘提交前通知、重启错误取消已绑定会话的执行。既有公开/隐藏链路能够检出，运行 `pnpm task:mutants INT-TRADING`；这只是对列举反例的验证，不表示所有错误均被覆盖。
