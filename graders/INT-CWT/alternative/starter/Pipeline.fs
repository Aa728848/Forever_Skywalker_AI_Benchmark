module BenchmarkPipeline

open System
open System.IO
open System.Text
open System.Threading
open FSharp.Data
open FSharp.Data.JsonExtensions
open LSP
open LSP.Types
open LSP.Locking
open CWTools.Main.DiagnosticInvalidation
open RefreshLockPhases

type Plan = { Path: string; Version: int; Generation: int64; Admission: Admission option; Symbols: string list; Errors: int }

/// 合成编辑器适配：下游文本、协议、锁与失效跟踪均使用固定提交的原模块。
type Pipeline(onPublished: string -> unit) =
    let documents = DocumentStore()
    let tracker = Tracker()
    let rootLock = new ReaderWriterLockSlim(LockRecursionPolicy.NoRecursion)
    let timings = TimingCollector((fun () -> TimeSpan.Zero), (fun () -> rootLock.IsWriteLockHeld))
    let mutable generation = 0L
    let mutable symbols: Map<string, string list> = Map.empty
    let mutable diagnostics: Map<string, int> = Map.empty
    let identity path = PathIdentity.normalize path
    let write action =
        rootLock.EnterWriteLock()
        try action ()
        finally rootLock.ExitWriteLock()

    member _.Feed(bytes: byte[]) =
        use stream = new MemoryStream(bytes)
        use reader = new BinaryReader(stream, Encoding.UTF8)
        for body in LSP.Tokenizer.tokenize reader do
            let json = JsonValue.Parse body
            let notification = LSP.Parser.parseNotification(json.GetProperty("method").AsString(), Some(json.GetProperty("params")))
            write (fun () ->
                match notification with
                | DidOpenTextDocument doc ->
                    documents.Open doc
                    tracker.Invalidate(Domain.NonLocalisation, Targeted(Set.singleton (identity doc.textDocument.uri.LocalPath)))
                | DidChangeTextDocument doc ->
                    documents.Change doc
                    tracker.Invalidate(Domain.NonLocalisation, Targeted(Set.singleton (identity doc.textDocument.uri.LocalPath)))
                | DidCloseTextDocument doc ->
                    documents.Close doc
                    let path = identity doc.textDocument.uri.LocalPath
                    generation <- generation + 1L
                    tracker.Delete path
                    symbols <- Map.remove path symbols
                    diagnostics <- Map.remove path diagnostics
                | _ -> invalidArg "bytes" "仅接受文档 open/change/close 通知")

    member _.Configure() =
        write (fun () ->
            generation <- generation + 1L
            tracker.Invalidate(Domain.NonLocalisation, GlobalUnknown)
            symbols <- Map.empty
            diagnostics <- Map.empty)

    member _.Prepare(path: string) =
        let path = identity path
        let timing = createRequestExecutionTiming ()
        let capture =
            runTracedReadLocked rootLock None CancellationToken.None (fun () -> 0L) timing (async {
                let text, version = documents.Get(FileInfo(path)) |> Option.defaultWith (fun () -> invalidArg "path" "文档未打开")
                return text, version, generation, tracker.TryAdmit(Domain.NonLocalisation, path) })
        let text, version, capturedGeneration, admission =
            match capture with Acquired snapshot -> snapshot | TimedOut -> failwith "读取超时"
        timings.Measure { Phase = PrepareOutsideLock; Kind = ExpensiveCallback; Run = fun () ->
            let words = text.Split([|' '; '\n'; '\r'; '\t'|], StringSplitOptions.RemoveEmptyEntries) |> Array.toList
            { Path = path; Version = version; Generation = capturedGeneration; Admission = admission
              Symbols = words |> List.distinct |> List.sort; Errors = words |> List.filter ((=) "error") |> List.length } }

    member _.Publish(plan: Plan) =
        let published = write (fun () ->
            // 只允许当前文档与当前配置代际下的精确准入发布。
            let current = match documents.GetVersionByPath(plan.Path) with
                          | Some version when version = plan.Version && plan.Generation = generation ->
                              sameAdmission (tracker.TryAdmit(Domain.NonLocalisation, plan.Path)) plan.Admission
                          | _ -> false
            if current then
                symbols <- Map.add plan.Path plan.Symbols symbols
                diagnostics <- Map.add plan.Path plan.Errors diagnostics
                plan.Admission |> Option.iter (fun admission -> tracker.Complete(true, admission))
            current)
        if published then
            timings.Measure { Phase = FollowupOutsideLock; Kind = ExpensiveCallback; Run = fun () -> onPublished plan.Path }
        published

    member _.Text(path: string) = documents.GetTextByPath(path)
    member _.Symbols(path: string) = Map.tryFind (identity path) symbols
    member _.Errors(path: string) = Map.tryFind (identity path) diagnostics
    member _.Retained = documents.OpenFiles().Length + symbols.Count + diagnostics.Count + tracker.Counts(Domain.NonLocalisation).RetainedEntries
    member _.WriteHeld = rootLock.IsWriteLockHeld
    interface IDisposable with member _.Dispose() = rootLock.Dispose()
