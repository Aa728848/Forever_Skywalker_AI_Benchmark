#load "../starter/bootstrap.fsx"
open System
open System.IO
open System.Text
open System.Text.Json
open System.Threading
open BenchmarkPipeline
let mutable count = 0
let mutable failed = 0
let report name action =
    count <- count + 1
    try action (); printfn "ok %d - %s" count name
    with error -> failed <- failed + 1; printfn "not ok %d - %s" count name; printfn "  ---\n  error: %s\n  ..." (error.Message.Replace("\n", " "))
let check condition message = if not condition then failwith message
let path = Path.Combine(Path.GetTempPath(), "int-cwt-document.txt")
let uri = Uri(path).AbsoluteUri
let quote (text: string) = JsonSerializer.Serialize(text)
let frame methodName parameters =
    let body = "{\"jsonrpc\":\"2.0\",\"method\":" + quote methodName + ",\"params\":" + parameters + "}"
    Encoding.UTF8.GetBytes("Content-Length: " + string (Encoding.UTF8.GetByteCount(body)) + "\r\n\r\n" + body)
let opened version text = frame "textDocument/didOpen" ("{\"textDocument\":{\"uri\":" + quote uri + ",\"languageId\":\"stellaris\",\"version\":" + string version + ",\"text\":" + quote text + "}}")
let replaced version text = frame "textDocument/didChange" ("{\"textDocument\":{\"uri\":" + quote uri + ",\"version\":" + string version + "},\"contentChanges\":[{\"text\":" + quote text + "}]}")
let closed = frame "textDocument/didClose" ("{\"textDocument\":{\"uri\":" + quote uri + "}}")
#load "UpstreamRegression.fsx"
report "public/original-documentstore-regression" UpstreamRegression.run
report "public/editor-change-updates-cache-index-diagnostics" (fun () ->
    use pipeline = new Pipeline(ignore)
    pipeline.Feed(opened 1 "alpha error")
    check (pipeline.Publish(pipeline.Prepare(path))) "首次诊断未发布"
    pipeline.Feed(replaced 2 "beta good")
    check (pipeline.Publish(pipeline.Prepare(path))) "更新诊断未发布"
    check (pipeline.Text(path) = Some "beta good") "文本缓存未更新"
    check (pipeline.Symbols(path) = Some ["beta"; "good"] && pipeline.Errors(path) = Some 0) "索引/诊断仍为旧内容")
report "public/close-isolates-late-publication" (fun () ->
    use pipeline = new Pipeline(ignore)
    pipeline.Feed(opened 1 "error")
    let plan = pipeline.Prepare(path)
    pipeline.Feed(closed)
    check (not (pipeline.Publish(plan))) "关闭后仍发布迟到诊断"
    check (pipeline.Symbols(path).IsNone && pipeline.Errors(path).IsNone) "关闭后留下索引")
report "public/original-write-lock-releases-on-error" (fun () ->
    use gate = new ReaderWriterLockSlim(LockRecursionPolicy.NoRecursion)
    let result = LSP.Locking.runWriteRequestTerminal (fun () -> gate.EnterWriteLock()) (fun () -> gate.ExitWriteLock()) CancellationToken.None (async { return raise (InvalidOperationException("fault")) })
    check (result = LSP.Locking.RequestTerminalCause.Exception) "异常分类错误"
    check (not gate.IsWriteLockHeld) "异常后写锁未释放"
    check (gate.TryEnterWriteLock(1000)) "后续写锁不能获得"
    gate.ExitWriteLock())
printfn "# checks %d failed %d" count failed
if failed > 0 then exit 1
