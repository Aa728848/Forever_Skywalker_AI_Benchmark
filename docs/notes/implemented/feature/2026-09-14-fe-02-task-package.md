# Agent Note: FE-02 题目包（异步请求乱序与取消）——中等档首题

Status: implemented

## Problem

中等档第一题考的是前端最常见的竞态：同 key 的新请求必须取代旧请求，
过期的返回不得覆盖最新结果；同时 `pending` 计数与 `cancelAll()` 必须真实反映生命周期。

## Decision

- 冻结 `RequestCoordinator`（`request` / `pending` / `cancelAll`）与 `RequestPort`（按 key 发请求、接收 `AbortSignal`），
  端口在检查里用可控假实现，按需结算，不用真实计时。
- 缺陷三处：① 同 key 不取代旧请求（不 abort、旧 promise 照常结算）；② `pending` 结算后不清理，只增不减；
  ③ `cancelAll()` 不 abort signal，且用普通 `Error` 而不是 `SupersededError` 拒绝。
- 参考实现统一走 `#settle`（结算一次、清 pending、abort 旧请求）；替代实现改成 generation 世代号判定最新请求。

## Alternatives considered

- 让缺陷表现为“被取代的 promise 永不结算”：这会**挂住检查阶段**（60 秒预算被打满），
  无法区分“被测失败”与“阶段故障”。第一版就是这么写的，starter 阶段 exit=null、全部检查缺失。
  改成三处都能在有界时间内结算的缺陷：不 abort、错误类型不对、计数不清理。
- 检查里先 `await` 旧 promise 再结算端口：同样会挂。现在改为**先结算端口再断言**，
  参考实现必然已拒绝，缺陷实现则拿到过期结果，两者都能立刻得出结论。

## Consequences

- 中等档开始，核心题 19/48；简单档保持 12/12。
- 这道题给出了“竞态类题目怎么避免挂死”的范式：缺陷必须让所有 promise 在有界时间内结算，
  观察点在**副作用**（signal 是否 abort、错误类型、计数）而不是“是否还在等”。

## Verification

- `node scripts/task.ts verify FE-02`：六阶段通过——起始版本只被 10 个声明检出项判失败，
  参考实现与替代实现全部通过。
- `pnpm check`：exit 0。

