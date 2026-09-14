# Agent Note: 补齐后端、生命周期与跨层恢复题目的真实契约

Status: implemented

## Problem

API-02 仅覆盖分页，缺少目录承诺的幂等写入；API-03 只有字符串解析，没有 UTF-8 字节边界及背压。LIFE-04 用假 ChildPort 记账，缺少真实后代回收、裁判自触发阻断与快照代际。STATE-04 只有同步层回滚，没有实际持久化和进程故障恢复。

## Decision

四题均保留原公开 API，新增独立模块与公开契约，版本提升为 0.1.1，目录由唯一写者同步。

- API-02：同键同请求的在途/完成结果合并、冲突拒绝、失败后显式重试、不同键互不阻塞。
- API-03：真实 Uint8Array 输入、UTF-8 流式解码、有界事件队列与未闭合帧字节预算、失败态及已交付游标重连。
- LIFE-04：真实 Node 子进程与后代进程、退出/超时分类、启动错误释放、judge 上下文阻断、快照代际隔离。检查在 finally 中释放自身创建的残留子进程。
- STATE-04：真实文件持久事务、缓存/界面投影重建、事务键幂等、乱序重复通知收敛；隐藏检查真实启动子进程并在提交后 exit。参考使用原子 JSON 日志，替代实现使用追加 JSONL 事务日志。

## Alternatives considered

未把目录降低成原先较窄的题面；未删除旧 API 或旧回归检查。持久化只覆盖题面规定的单写者与进程崩溃边界，没有宣称模拟断电或分布式数据库。LIFE-04 没有继续把假 kill 调用次数当作真实回收证据。

## Consequences

每题均有明确缺陷 starter、受信参考补丁和不同结构替代实现，隐藏要求均在题面公开。实际 Linux 容器及 Linux 父进程已退出后的孤儿进程组路径仍需容器运行环境验证；本机 Windows 真实活跃进程树回收不能冒充该项已通过。

## Verification

- `pnpm typecheck`：通过。
- `node scripts/task.ts verify API-02`：六阶段通过，原始证据 `data/task-runs/API-02/2026-09-14T09-57-28-053Z`。
- `node scripts/task.ts verify API-03`：六阶段通过，原始证据 `data/task-runs/API-03/2026-09-14T09-57-28-151Z`。
- `node scripts/task.ts verify STATE-04`：六阶段通过，原始证据 `data/task-runs/STATE-04/2026-09-14T09-51-39-567Z`。
- `node scripts/task.ts verify LIFE-04`：完整进程权限下六阶段通过，原始证据 `data/task-runs/LIFE-04/2026-09-14T09-56-43-869Z`。所有缺陷失败项与声明匹配，参考和替代全部通过。
