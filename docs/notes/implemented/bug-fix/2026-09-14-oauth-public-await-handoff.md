# Agent Note: 认证公开入口Promise交接的生命周期隔离

Status: implemented

## Problem

独立复核INT-SUB 0.2.0发现真实参考与替代都存在异步交接缺口：loadAuthenticated内部读取完成并校验生命周期后，credentials/refresh的await续体尚未执行；logout可以在这两个微任务之间发生。旧请求随后按注销后的新代际发起刷新并重新写入凭据。已用真实替代OAuthService、MemoryTokenStore与合成fetch复现：双层queueMicrotask安排logout，credentials(true)/refresh返回新凭据且最终存储非空，credentials(false)也能返回旧令牌。

原延迟存储读取检查覆盖logout发生在load内部等待期，尚未覆盖公开入口接过结果的窗口。另平台typecheck明确指出四个核心题存在6处未用导入/变量。

## Decision

- credentials和refresh分别在公开调用入口捕获生命周期身份，在等待load/refresh/最终status后核对同一身份，最终返回前不能把旧操作归入新代。
- 参考使用数值代际，替代继续使用原AbortSignal身份；凭据写入队列保持原结构。
- 新增hidden/state-public-await-handoff-cannot-revive-auth：用显式微任务深度0..6交错logout/dispose与credentials(true)/refresh，检查撤销后不能发起新刷新、logout完成后存储为空。允许更快的正确实现先完成，不根据私有方法名或固定内部await数量判断结果，不使用计时sleep。
- late-read-generation反例同步为公开入口和共享读取都在读取后才捕获代际，保持原ID与预声明目标不变。只移除内部守卫在新版中已是冗余变化，不能再冒称有效错误。
- 删除ARCH-02/03公共测试和starter未用导入、ARCH-04公共测试未用turn、LIFE-02公共测试未用StreamEvent；参考仍需要的导入通过参考补丁恢复。不关闭strict/noUnused，也不增加无意义void。

## Alternatives considered

只在loadAuthenticated内部增加检查仍遗漏外层await交接；只在刷新写入后检查也无法阻止注销之后才启动的不必要请求。没有引入轮询或把每个异步操作塞入全局锁。旧反例若仅删除冗余内部断言会成为等价正确实现，因此更新其错误变换位置而保留语义与预声明目标。

## Consequences

INT-SUB维持本轮尚未发布的0.2.0，检查数从8增为9；starter检出项预声明增加1项。原接口、错误代码、刷新合并、凭据保存/清理队列和真实来源资产保持。没有真实网络或模型调用。

## Verification

- `pnpm task:verify INT-SUB`：六阶段通过，9项参考/替代检查全过；`data/task-runs/INT-SUB/2026-09-14T13-57-55-445Z`。
- `pnpm task:mutants INT-SUB`：3/3有效检出，旧目标不变；late-read-generation额外命中新交接检查并原样保留；`data/task-mutations/INT-SUB/2026-09-14T13-57-56-970Z`。
- ARCH-02/03/04、LIFE-02三向均再次通过；记录目录分别为 `2026-09-14T13-57-59-566Z`、`2026-09-14T13-58-00-899Z`、`2026-09-14T13-57-57-666Z`、`2026-09-14T13-58-00-750Z`（位于各自data/task-runs/<ID>/）。
- ARCH-03/04反例各3/3通过；记录 `data/task-mutations/ARCH-03/2026-09-14T13-58-02-230Z` 与 `data/task-mutations/ARCH-04/2026-09-14T13-57-58-979Z`。
- `pnpm typecheck`通过；根任务将ECMAScript lib调整为匹配Node24的ES2024，无需替换Promise.withResolvers。

Linux全量和平台整体验收由根任务统一进行。临时生成脚本位于系统临时目录并在交付前删除。
