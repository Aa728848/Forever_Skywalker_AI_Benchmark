# INT-SUB · 订阅适配器认证与流生命周期

题目版本：0.2.0；赛道：原仓库模块集成；固定来源版本和逐文件SHA-256见starter/SOURCE.json。

修复真实OAuthService和流看门狗两条相互关联的生命周期：同实例并发刷新仍应合并一次网络调用，服务端不轮换refresh_token时保留旧令牌；logout、取消登录或dispose发生后，旧认证操作不得重新保存凭据，返回not-authenticated。尤其异步store.save已开始时，logout也必须等待串行清理完成，不能在logout完成后复活凭据。dispose后credentials不得工作。

流消费提前停止必须取消给source的真实AbortSignal、执行iterator.return并释放watchdog；上游取消应映射ABORTED。只改 starter/src/host/oauth-service.ts 与 starter/src/host/common/idle-watchdog.ts，保持公共签名、错误代码和正常令牌刷新行为。真实MemoryTokenStore/TimeoutReason/idleWatchdog/错误模块参与执行；唯一替身为合成OAuth HTTP响应与流源，不访问真实账户或凭据，也不启动交互登录。

认证操作的生命周期从调用 `credentials` 或 `refresh` 开始，包括异步读取 TokenStore 的等待期。若在读取过程中注销或dispose，迟到读取即使返回未过期的旧令牌，也必须以 `not-authenticated` 拒绝，不能向调用方返回旧凭据，也不能启动刷新或重新保存。生命周期检查还须覆盖共享读取函数返回与公开入口继续执行之间的Promise交接，以及等待刷新/最终状态后的返回时刻；不能在旧操作继续执行时重新捕获新生命周期而绕过撤销。未轮换refresh_token、存储失败重试、同一生命周期的刷新合并保持原语义。

已经取消的上游信号在开始消费时直接以 `ABORTED` 拒绝，不能调用source创建传输；正常消费过程中取消和提前break仍按原清理顺序释放。这些检查使用受信屏障控制存储读取/保存，避免以定时sleep猜测并发顺序。

## 来源与运行边界

本题是固定原仓库源码的模块子集，保留原始路径、接口、注释和许可证；不代表完整原应用。只允许修改题面指定的starter源码，公开检查和SOURCE.json保持不变。原始工作区只读。检查使用合成输入和明确的外部服务替身，所有被测业务模块均为真实上游源码。

固定依赖：Node.js24.14.1；同一冻结subscription源码的OAuth/MemoryTokenStore/callback/compat模块；deepseek-harness固定2377c272...的真实timeout和完整index.ts/error.ts，受信加载器只提取index中的原LlmError声明（不是替身），附第二份MIT与hash。

运行：node --test --test-isolation=process --test-reporter=tap "public-tests/**/*.test.mjs"。

可用分覆盖行为、边界、状态、回归与资源五组。三向通过仅推进fixture-ready；正式容器、校准和代码评审证据齐备后才发布正式成绩。
