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
report "hidden/configuration-generation-rejects-old-plan" (fun () ->
    use pipeline = new Pipeline(ignore)
    pipeline.Feed(opened 1 "error")
    let plan = pipeline.Prepare(path)
    pipeline.Configure()
    check (not (pipeline.Publish(plan))) "配置切换后旧代际仍可发布")
report "hidden/incremental-text-matches-full-document" (fun () ->
    use pipeline = new Pipeline(ignore)
    pipeline.Feed(opened 1 "alpha error\nbeta good")
    pipeline.Text(path) |> ignore
    let edits = "{\"textDocument\":{\"uri\":" + quote uri + ",\"version\":2},\"contentChanges\":[{\"range\":{\"start\":{\"line\":0,\"character\":6},\"end\":{\"line\":0,\"character\":11}},\"text\":\"good\"},{\"range\":{\"start\":{\"line\":1,\"character\":5},\"end\":{\"line\":1,\"character\":9}},\"text\":\"error\"}]}"
    pipeline.Feed(frame "textDocument/didChange" edits)
    check (pipeline.Text(path) = Some "alpha good\nbeta error") "增量文本与全量不同"
    check (pipeline.Publish(pipeline.Prepare(path))) "增量索引未发布"
    check (pipeline.Errors(path) = Some 1) "增量诊断与全量不同")
report "hidden/reopen-same-version-rejects-prior-lifecycle" (fun () ->
    use pipeline = new Pipeline(ignore)
    pipeline.Feed(opened 1 "old")
    let old = pipeline.Prepare(path)
    pipeline.Feed(closed)
    pipeline.Feed(opened 1 "new")
    check (not (pipeline.Publish(old))) "重开文档的相同版本号接收了旧生命周期结果")
report "hidden/closed-workspace-releases-retained-state" (fun () ->
    use pipeline = new Pipeline(ignore)
    for version in 1 .. 50 do
        pipeline.Feed(opened version "value")
        pipeline.Publish(pipeline.Prepare(path)) |> ignore
        pipeline.Feed(closed)
    check (pipeline.Retained = 0) "关闭后缓存/索引/失效状态仍保留条目")
report "hidden/notification-runs-after-root-release" (fun () ->
    let mutable active: Pipeline option = None
    use pipeline = new Pipeline(fun _ -> check (not active.Value.WriteHeld) "回调仍持有根写锁")
    active <- Some pipeline
    pipeline.Feed(opened 1 "value")
    check (pipeline.Publish(pipeline.Prepare(path))) "正常发布失败")
printfn "# checks %d failed %d" count failed
if failed > 0 then exit 1
