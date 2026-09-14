# INT-CWT · LSP、缓存与编辑器全链路

极度困难，原仓库集成题，版本 0.1.0。运行时 .NET 10，离线携带原依赖 FSharp.Data 3.3.1。集成成绩独立报告。

## 固定来源与任务边界

来源是 cwtools-vscode 的提交 `753a0d7c2df1f4285911febf2d10a949887f4499`。PROVENANCE.json 列出源文件及 SHA-256；starter/upstream 保存 Tokenizer、Parser、Ser、Types、DocumentStore、PathIdentity、Locking、DiagnosticInvalidation、RefreshLockPhases 等原始模块和 MIT 许可。starter/lib 保存固定依赖、包元数据与 Apache 2.0 许可。运行时不联网拉取包。

这是原模块的跨层集成，合成编辑器通过真实 Content-Length JSON-RPC 字节流发送 open/change/close，下游使用原协议解析、增量文档缓存、真实 F# 锁及诊断失效跟踪。索引和诊断采用公开的轻量确定性分析：按空白分词，索引为去重排序词列表，诊断数为精确单词 error 的次数。没有启动 VSCode GUI、CWTools 游戏分析器或全仓构建，不得把本题通过宣传为整个来源仓库测试通过。

## 缺陷与可修改范围

1. `starter/upstream/src/LSP/DocumentStore.fs` 注入了缓存版本判断缺陷，文本编辑后仍返回旧字符串。
2. `starter/Pipeline.fs` 的 Publish 忽略文档版本、关闭/重开生命周期及配置代际，迟到结果可错误发布。

只修改以上两个文件；保留全部原模块公开签名、既有注释和上游许可，不能替换成自写的假 DocumentStore/锁/解析器。不得修改检查、依赖二进制和其它上游源文件。

## 公开集成接口

`#load "starter/bootstrap.fsx"` 后使用 `BenchmarkPipeline`：

```fsharp
type Plan = { Path: string; Version: int; Generation: int64; Admission: Admission option; Symbols: string list; Errors: int }
type Pipeline =
    new: (string -> unit) -> Pipeline
    member Feed: byte[] -> unit
    member Configure: unit -> unit
    member Prepare: string -> Plan
    member Publish: Plan -> bool
    member Text: string -> string option
    member Symbols: string -> string list option
    member Errors: string -> int option
    member Retained: int
    member WriteHeld: bool
    interface System.IDisposable
```

- Feed 接受完整的一个或多个原 LSP 帧；UTF-8 Content-Length 按字节计算。didChange 保留上游完整替换及同版本消息内多条增量编辑语义。
- Prepare 只准备快照，不发布；Publish 只接受仍在打开、版本相同、配置/生命周期代际相同且诊断 admission 仍精确的 Plan。被拒绝的 Plan 返回 false，不改变索引、诊断或当前失效状态，不通知界面。
- 关闭文档清除文本、索引、诊断及单文件失效状态；相同 URI/版本重开也不得接受旧生命周期结果。
- Configure 切换代际、使旧计划失效并清除已发布投影；新 Prepare/Publish 可恢复当前索引和诊断。
- 发布通知只在根写锁释放后执行；原 Locking 的异常路径必须释放真实锁，后续请求仍可取得锁。
- 多条增量编辑后的文本、索引、诊断须与完整文本分析一致。关闭后的保留条目归零，不能无限积累。

## 验证

在候选根目录执行 `dotnet fsi public-tests/checks.fsx`。公开检查保留上游 DocumentStore.Tests.fsx 的实际断言，仅适配加载路径和 TAP 包装；隐藏检查增加配置切换、同版本重开、多编辑增量一致性、通知锁边界与保留资源检查。

starter 必须失败；原模块恢复后的基线、参考补丁和不同条件结构的替代实现须通过。容器执行与正式发布校准单列，宿主验证不等于正式隔离成绩。
