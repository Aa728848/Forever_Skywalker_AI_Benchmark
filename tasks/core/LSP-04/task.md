# LSP-04 · 并行工作区增量索引与安全发布

题目版本：0.1.1；难度：extreme；运行时：F# / .NET 10。

## 固定接口与契约

Build={Id:int; Workspace:string; Generation:int; Token:CancellationToken}。Index.Begin(workspace:string,generation:int,expected:string list):Build；Stage(build:Build,path:string,symbols:string list option):bool；Publish(build:Build):bool；Abort(build:Build):unit；Snapshot(workspace:string):Map<string,string list>。

Begin声明本代要更新的文档路径，generation须严格递增（首次>=0）。新代取消同工作区旧Token。Stage(Some symbols)更新文档符号，None删除；未声明路径抛ArgumentException，旧Build返回false。所有expected路径都有Stage结果后Publish才可成功，一次提交原子生效并保留未变文档；未齐全、已发布、已中止或旧代Publish返回false。任何Stage/Abort/失败都不得暴露半成品。不同工作区相互隔离。所有方法可被真实.NET线程并发调用，Snapshot须为稳定的不可变快照。

## 修改与执行

只修改 starter/；不得修改公开检查、固定接口或隐藏资产，不引入第三方依赖。

公开验证：

```text
dotnet fsi public-tests/checks.fsx
```

参考解和结构不同的替代实现均须通过，起始缺陷须被检出。fixture-ready 仅代表三向验证通过，正式容器与难度校准后才可发布。

## 评分证据分组

本版按真实断言覆盖行为、边界、状态、回归、资源五组；各检查权重见manifest.json。缺组时不产生完整可用分。
