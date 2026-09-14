# THR-03 · 读写锁、锁外回调和异常释放

- 难度：困难；题型：独立核心题；能力域：多线程。
- 运行时：F# / .NET 10（`dotnet fsi` 直接运行 `.fsx` 脚本，使用真实 .NET 线程）。
- 题目版本：0.2.0（相对 0.1.0 的设计调整：题目包只用 .NET 真实线程实现，不再混入 TypeScript 侧）；评分规则版本：0.1.0。

## 背景

`starter/` 是一个可独立运行的最小项目，`starter/src/ReadWriteGate.fsx` 提供读/写临界区。
当前实现把读与写都放进同一个监视器（读被串行化），并且释放锁的代码不在 `try/finally` 里
（回调抛异常后锁永久不释放）。请在**不改变公开接口**的前提下修复。

## 公开接口（冻结，不得修改签名、导出名与文件路径）

```fsharp
module ReadWriteGate

type Snapshot = { Readers: int; Writers: int; Waiters: int }

type Gate =
    new: unit -> Gate
    member WithRead<'T> : (unit -> 'T) -> 'T
    member WithWrite<'T> : (unit -> 'T) -> 'T
    member Snapshot: unit -> Snapshot
```

## 必须满足的行为契约

1. 互斥：任何时刻 `Writers ≤ 1`；`Writers = 1` 时 `Readers = 0`。
2. 读并发：至少两个读区可以**同时**存在，不得把读也串行化。
3. 写优先且不饿死：存在等待中的写者时，新读者必须排队，不得插队。
4. 异常释放：`WithRead` / `WithWrite` 的回调抛异常时必须向上传播，并且锁必须已释放——之后的读或写必须能正常获取。
5. 计数一致：在读区内调用 `Snapshot()` 看到 `Readers ≥ 1`；在写区内看到 `Writers = 1`；离开后恢复为 0。
6. 回调返回值必须原样返回。
7. 等待必须使用 `Monitor.Pulse`/`Wait` 或等价的阻塞原语，不得自旋轮询。

## 限制

- 答案范围限于 `starter/`；不要修改 `public-tests/`。
- 不得引入 NuGet 依赖；只用 .NET 基础库。
- 只能修改 `starter/src/ReadWriteGate.fsx`（公开签名与模块名不得变化）。

## 公开检查

检查脚本用真实线程与带超时的 `Barrier` 构造交错，在**工作区根目录**运行：

```powershell
dotnet fsi public-tests/checks.fsx
```

检查对每个可能阻塞的调用都有超时，因此死锁会表现为检查失败而不是挂住整批检查。

## 判定

- 参考实现通过全部公开与未公开检查。
- 注入目标缺陷的起始版本必须被检出（失败项限于预先声明的检出项），其余已正确行为不得回归。
- 与参考实现结构不同的替代实现也必须通过同一契约。
- 本阶段只产出检查通过或失败；代码质量评审接入前总分保持待定。
