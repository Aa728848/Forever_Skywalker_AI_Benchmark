# INT-TRADING · 模拟行情与账本恢复一致性

题目版本：0.1.0；赛道：原仓库模块集成；固定来源版本和逐文件SHA-256见starter/SOURCE.json。

本题保留 dsh-trading 固定提交的真实 TasksLedger、tasks-protocol、tasks-schedule 和 TtlCache。使用合成报价驱动任务动作，再验证缓存过期、动作协议、真实磁盘账本和重启恢复的一致性；这是行情触发任务账本的模块集成，未包含券商接入或真实交易。

修复 starter/packages/client-ui-trading/src/tasks/ledger.ts：任意写盘失败时内存快照/revision/幂等键及订阅通知不得先行，旧文件必须保持；同请求重试成功后只出现一条任务。保留原类公共API、同键异载荷冲突、目录锁、调度计算、未创建会话的启动中断取消、有会话的在途执行保留、执行历史上限等行为。不得更改其它源模块或许可证。

## 来源与运行边界

本题是固定原仓库源码的模块子集，保留原始路径、接口、注释和许可证；不代表完整原应用。只允许修改题面指定的starter源码，公开检查和SOURCE.json保持不变。原始工作区只读。检查使用合成输入和明确的外部服务替身，所有被测业务模块均为真实上游源码。

固定依赖：Node.js 24.14.1 标准库；源提交内的协议、cron调度、TTL缓存四模块，无第三方运行时包。

运行：node --test --test-isolation=process --test-reporter=tap "public-tests/**/*.test.mjs"。

可用分覆盖行为、边界、状态、回归与资源五组。三向通过仅推进fixture-ready；正式容器、校准和代码评审证据齐备后才发布正式成绩。
