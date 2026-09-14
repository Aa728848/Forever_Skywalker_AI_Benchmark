# LSP-02 · UTF-16 增量编辑与版本

题目版本：0.1.1；难度：medium；运行时：F# / .NET 10。

## 固定接口与契约

Position={Line:int; Character:int}；Span={Start:Position; Finish:Position}；Edit={Range:Span option; Text:string}；Document={Text:string; Version:int}。

apply : Document -> int -> Edit list -> Result<Document,string>。位置采用零基行号、UTF-16代码单元列号；支持LF/CRLF，列号不能进入换行符，末尾换行后的空行合法。Range=None表示全量替换。变更按顺序应用到上一变更后的文本，整体成功或失败，输入Document不变。负值、越界或反向范围返回Error "invalid range"；版本必须严格递增，否则Error "stale version"。空变更也推进版本。

## 修改与执行

只修改 starter/；不得修改公开检查、固定接口或隐藏资产，不引入第三方依赖。

公开验证：

```text
dotnet fsi public-tests/checks.fsx
```

参考解和结构不同的替代实现均须通过，起始缺陷须被检出。fixture-ready 仅代表三向验证通过，正式容器与难度校准后才可发布。

## 评分证据分组

本版按真实断言覆盖行为、边界、状态、回归、资源五组；各检查权重见manifest.json。缺组时不产生完整可用分。
公开资源预算：50000行文档末尾编辑在5秒内完成，当前线程累计分配低于64MiB；这是开发预算，正式成绩另需固定环境校准。
