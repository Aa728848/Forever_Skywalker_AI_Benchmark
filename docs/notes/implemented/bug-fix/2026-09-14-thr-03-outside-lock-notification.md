# Agent Note: 补齐 THR-03 的锁外通知与写者优先验证

Status: implemented

## Problem

THR-03 目录要求用户通知在锁外运行，但既有 Gate 只有 WithRead/WithWrite，回调都属于受保护的临界区。仅释放内部计数 Monitor 不能证明已释放读写锁。写者优先检查没有先确认写者已排队，替代实现的 Waiters 也一直返回 0。

## Decision

保留已有接口，增加 WithWriteThen(action, notify)：在写临界区修改，释放后调用通知；通知异常不持锁。公开检查通过另一个真实线程在通知中获取读锁，隐藏检查覆盖通知异常、已排队写者不被新读者越过。明确 Waiters 为等待写者数量，修正替代实现的可观察计数。题目与目录版本同步为 0.2.1。

## Alternatives considered

未把 WithRead/WithWrite 改为锁外回调，因为这会破坏临界区保护及既有公开 API。未通过改低目录要求掩盖缺少锁外回调的事实。

## Consequences

测试保持真实 .NET 线程与有界同步，起始版本新增三个明确检出项，参考补丁与结构不同的替代实现满足同一接口。此次为宿主题目包验证，Linux 容器验证仍单列。

## Verification

`node scripts/task.ts verify THR-03` 六阶段通过：starter 恰好七项声明缺陷失败，reference 和 alternative 的公开/隐藏检查全部通过，无缺失 ID。原始证据：`data/task-runs/THR-03/2026-09-14T08-51-52-006Z`。
