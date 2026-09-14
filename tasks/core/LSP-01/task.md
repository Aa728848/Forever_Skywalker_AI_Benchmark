# LSP-01 · JSON-RPC 消息边界

- 难度：简单；题型：独立核心题；能力域：LSP 与编辑器协议。
- 运行时：F# / .NET 10（`dotnet fsi` 直接运行 `.fsx` 脚本，不需要额外依赖）。
- 题目版本：0.1.0；评分规则版本：0.1.0。

## 背景

`starter/` 是一个可独立运行的最小项目，`starter/src/FrameParser.fsx` 从字节缓冲里切出 LSP 风格的消息帧。
当前实现先把整个缓冲解码成字符串再切分，并用字符个数当作正文长度，因此
多字节正文、分包读取与未完整到达的消息都会出错。请在**不改变公开接口**的前提下修复。

## 公开接口（冻结，不得修改签名、导出名与文件路径）

```fsharp
module FrameParser

/// 返回 (已完整解析出的消息体文本, 尚未消费的剩余原始字节)
val parseFrames: buffer: byte[] -> Result<string list * byte[], string>
```

## 必须满足的行为契约

1. 输入是若干 `Content-Length: N\r\n\r\n<body>` 帧；返回按出现顺序排列的正文文本（UTF-8 解码）。
2. 剩余字节必须是**最后一个不完整帧的原始前缀**，供下次拼接使用；已完整解析的消息不得被丢弃或重复解析。
3. `Content-Length` 以**字节**计量：含中文或 emoji 的正文必须按字节边界切分，不得按 .NET 字符串长度（字符数）计算。
4. 头部名大小写不敏感；头部行顺序不固定时仍可解析。
5. 缺少 `Content-Length` → `Error "missing content-length"`；长度不是非负十进制整数 → `Error "invalid content-length"`。
6. 头部尚未以空行结束、或正文尚未收全时，不得报错：返回已经解析出的消息与剩余字节。
7. 长度为 0 的正文合法。

## 限制

- 答案范围限于 `starter/`；不要修改 `public-tests/`。
- 不得引入 NuGet 依赖；只用 .NET 基础库。
- 只能修改 `starter/src/FrameParser.fsx`（公开签名与模块名不得变化）。

## 公开检查

检查脚本是 TAP 风格的 F# 脚本，在**工作区根目录**运行：

```powershell
dotnet fsi public-tests/checks.fsx
```

## 判定

- 参考实现通过全部公开与未公开检查。
- 注入目标缺陷的起始版本必须被检出（失败项限于预先声明的检出项），其余已正确行为不得回归。
- 与参考实现结构不同的替代实现也必须通过同一契约。
- 本阶段只产出检查通过或失败；代码质量评审接入前总分保持待定。
