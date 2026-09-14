#load "../starter/src/ReadWriteGate.fsx"

open System
open System.Collections.Concurrent
open System.Threading
open ReadWriteGate

let mutable passed = 0
let mutable failed = 0

let private report (name: string) (body: unit -> unit) =
    let number = passed + failed + 1
    try
        body ()
        passed <- passed + 1
        printfn "ok %d - %s" number name
    with error ->
        failed <- failed + 1
        printfn "not ok %d - %s" number name
        printfn "  ---"
        printfn "  error: %s" (error.Message.Replace("\n", " ").Replace("\r", " "))
        printfn "  ..."

let private startThread (work: unit -> unit) : Thread =
    let thread = Thread(ThreadStart(work))
    thread.IsBackground <- true
    thread.Start()
    thread

/// 带超时地调用可能被阻塞的锁操作：None 表示超时，Some (Error e) 表示回调抛异常。
let private attempt (milliseconds: int) (work: unit -> 'T) : Result<'T, exn> option =
    let store = ref None
    let failure = ref None
    let thread = Thread(ThreadStart(fun () ->
        try
            store.Value <- Some (work ())
        with error ->
            failure.Value <- Some error))
    thread.IsBackground <- true
    thread.Start()
    if not (thread.Join(milliseconds)) then None
    else
        match failure.Value with
        | Some error -> Some (Error error)
        | None -> Some (Ok store.Value.Value)

let private expectOk (label: string) (actual: Result<'T, exn> option) : 'T =
    match actual with
    | Some (Ok value) -> value
    | Some (Error error) -> failwith (label + "：抛出异常 " + error.Message)
    | None -> failwith (label + "：调用超时（锁可能没有释放）")

let private expectThrew (label: string) (actual: Result<'T, exn> option) : unit =
    match actual with
    | Some (Error _) -> ()
    | Some (Ok _) -> failwith (label + "：回调应当抛异常")
    | None -> failwith (label + "：调用超时（锁可能没有释放）")

let private joinWithin (milliseconds: int) (threads: Thread list) : bool =
    threads |> List.forall (fun thread -> thread.Join(milliseconds))

let private expectNoFailures (label: string) (failures: ConcurrentBag<string>) : unit =
    if not failures.IsEmpty then failwith (label + "：线程内异常 " + String.concat "；" failures)

/// 只在写区内使用，用于验证互斥；本身不加锁。
type private LooseCounter() =
    let mutable value = 0
    member _.Bump() = value <- value + 1
    member _.Current = value

report "public/read-returns-value" (fun () ->
    let gate = Gate()
    let value = expectOk "读区调用" (attempt 5000 (fun () -> gate.WithRead(fun () -> 42)))
    if value <> 42 then failwith "读区回调返回值不正确")

report "public/write-is-exclusive" (fun () ->
    let gate = Gate()
    let counter = LooseCounter()
    let violations = ConcurrentBag<int>()
    let failures = ConcurrentBag<string>()
    let worker () =
        for _ in 1 .. 2000 do
            gate.WithWrite(fun () ->
                let snapshot = gate.Snapshot()
                if snapshot.Writers <> 1 then violations.Add(snapshot.Writers)
                counter.Bump())
    let threads = [ for _ in 1 .. 4 -> startThread (fun () -> try worker () with error -> failures.Add(error.Message)) ]
    if not (joinWithin 20000 threads) then failwith "写区线程未能完成"
    expectNoFailures "写区线程" failures
    if counter.Current <> 8000 then failwith ("互斥失败：计数为 " + string counter.Current)
    if not violations.IsEmpty then failwith "写区内观察到 Writers 不为 1")

report "public/readers-run-concurrently" (fun () ->
    let gate = Gate()
    use barrier = new Barrier(2)
    let results = ConcurrentBag<bool>()
    let failures = ConcurrentBag<string>()
    let worker () = try results.Add(gate.WithRead(fun () -> barrier.SignalAndWait(3000))) with error -> failures.Add(error.Message)
    let threads = [ startThread worker; startThread worker ]
    if not (joinWithin 15000 threads) then failwith "读区线程未能完成"
    expectNoFailures "读区线程" failures
    let reached = results |> Seq.filter id |> Seq.length
    if reached <> 2 then failwith ("读区未能并发：只有 " + string reached + " 个读线程同时进入读区"))

report "public/releases-after-exception" (fun () ->
    let gate = Gate()
    expectThrew "写回调抛异常" (attempt 5000 (fun () -> gate.WithWrite(fun () -> failwith "回调失败")))
    let after = expectOk "异常之后的写区调用" (attempt 5000 (fun () -> gate.WithWrite(fun () -> 7)))
    if after <> 7 then failwith "异常之后锁状态不正确")

report "public/callback-runs-inside-lock" (fun () ->
    let gate = Gate()
    let readSnapshot = gate.WithRead(fun () -> gate.Snapshot())
    if readSnapshot.Readers < 1 then failwith "读区内 Readers 应当至少为 1"
    let writeSnapshot = gate.WithWrite(fun () -> gate.Snapshot())
    if writeSnapshot.Writers <> 1 then failwith "写区内 Writers 应当为 1")

report "public/counts-return-to-zero" (fun () ->
    let gate = Gate()
    for _ in 1 .. 50 do
        gate.WithRead(fun () -> ()) |> ignore
        gate.WithWrite(fun () -> ()) |> ignore
    let snapshot = gate.Snapshot()
    if snapshot.Readers <> 0 || snapshot.Writers <> 0 then failwith ("计数未回到 0：" + sprintf "%A" snapshot))

report "public/notification-runs-after-write-release" (fun () ->
    let gate = Gate()
    let observed = gate.WithWriteThen((fun () -> 41), (fun value ->
        let read = expectOk "通知期间另一个线程读取" (attempt 3000 (fun () -> gate.WithRead(fun () -> 1)))
        value + read))
    if observed <> 42 then failwith "通知参数或返回值被改变")

printfn "# passed %d failed %d" passed failed
if failed > 0 then exit 1
