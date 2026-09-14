# LSP-03 · 取消和过期诊断隔离

题目版本：0.1.1；难度：hard；运行时：F# / .NET 10。

## 固定接口与契约

Request={Id:int; Uri:string; Version:int; Token:CancellationToken}；Coordinator.Start(uri:string,version:int):Request；Complete(request:Request,diagnostics:string list):bool；Close(uri:string):unit；Published(uri:string):string list。

每个URI的新分析必须严格递增版本，否则抛ArgumentException。同URI新分析同步取消旧Token；异URI互不取消。只有当前在途Request可发布一次，旧分析/重复结果返回false且不得清空或覆盖已发布诊断。新分析启动保留已发布内容。Close取消在途分析并清空诊断与版本，重新打开可从低版本开始，但旧Request永远不能发布。取消使用真实.NET CancellationToken。所有操作支持多线程安全并发，单次发布原子可见。

## 修改与执行

只修改 starter/；不得修改公开检查、固定接口或隐藏资产，不引入第三方依赖。

公开验证：

```text
dotnet fsi public-tests/checks.fsx
```

参考解和结构不同的替代实现均须通过，起始缺陷须被检出。fixture-ready 仅代表三向验证通过，正式容器与难度校准后才可发布。

## 评分证据分组

本版按真实断言覆盖行为、边界、状态、回归、资源五组；各检查权重见manifest.json。缺组时不产生完整可用分。
