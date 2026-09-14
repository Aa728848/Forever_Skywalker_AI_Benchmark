# INT-SUB 受信验证

修复真实OAuthService和流看门狗两条相互关联的生命周期：同实例并发刷新仍应合并一次网络调用，服务端不轮换refresh_token时保留旧令牌；logout、取消登录或dispose发生后，旧认证操作不得重新保存凭据，返回not-authenticated。尤其异步store.save已开始时，logout也必须等待串行清理完成，不能在logout完成后复活凭据。dispose后credentials不得工作。

流消费提前停止必须取消给source的真实AbortSignal、执行iterator.return并释放watchdog；上游取消应映射ABORTED。只改 starter/src/host/oauth-service.ts 与 starter/src/host/common/idle-watchdog.ts，保持公共签名、错误代码和正常令牌刷新行为。真实MemoryTokenStore/TimeoutReason/idleWatchdog/错误模块参与执行；唯一替身为合成OAuth HTTP响应与流源，不访问真实账户或凭据，也不启动交互登录。

SOURCE.json记录固定提交和原始源码摘要；参考补丁、替代实现和隐藏检查留在受信侧。

缺陷来源：OAuthService固定上游源码存在logout/dispose与在途refresh竞争，可写回已注销凭据；另在真实idle-watchdog中注入消费停止不取消上游的回归。参考采用代际+串行凭据提交，替代用AbortController代际和异步互斥。

全部检查均运行真实源模块。运行 node scripts/task.ts verify INT-SUB 验证三向对照。
