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

report "hidden/concurrent-readers-meet" (fun () ->
    let gate = Gate()
    use barrier = new Barrier(4)
    let results = ConcurrentBag<bool>()
    let failures = ConcurrentBag<string>()
    let worker () = try results.Add(gate.WithRead(fun () -> barrier.SignalAndWait(3000))) with error -> failures.Add(error.Message)
    let threads = [ for _ in 1 .. 4 -> startThread worker ]
    if not (joinWithin 20000 threads) then failwith "读区线程未能完成"
    expectNoFailures "读区线程" failures
    let reached = results |> Seq.filter id |> Seq.length
    if reached <> 4 then failwith ("四个读线程未能同时进入读区：只有 " + string reached + " 个"))

report "hidden/exception-in-read-section-releases" (fun () ->
    let gate = Gate()
    expectThrew "读回调抛异常" (attempt 5000 (fun () -> gate.WithRead(fun () -> failwith "读回调失败")))
    let readers = expectOk "异常之后的读区调用" (attempt 5000 (fun () -> gate.WithRead(fun () -> gate.Snapshot().Readers)))
    if readers < 1 then failwith "异常之后读区状态不正确"
    let write = expectOk "异常之后的写区调用" (attempt 5000 (fun () -> gate.WithWrite(fun () -> true)))
    if not write then failwith "异常之后写区不可用")

report "hidden/writer-completes-while-readers-arrive" (fun () ->
    let gate = Gate()
    let released = new ManualResetEventSlim(false)
    let readerStarted = new ManualResetEventSlim(false)
    let failures = ConcurrentBag<string>()
    let writer = startThread (fun () -> try gate.WithWrite(fun () -> released.Wait(10000) |> ignore) with error -> failures.Add(error.Message))
    let reader = startThread (fun () -> try readerStarted.Set() |> ignore; gate.WithRead(fun () -> ()) |> ignore with error -> failures.Add(error.Message))
    if not (readerStarted.Wait(5000)) then failwith "读线程未能启动"
    released.Set() |> ignore
    if not (joinWithin 15000 [ writer; reader ]) then failwith "写者与读者未能先后完成"
    expectNoFailures "写者或读者" failures)

report "hidden/write-then-read-ordering" (fun () ->
    let gate = Gate()
    let shared = ref 0
    gate.WithWrite(fun () -> shared.Value <- 5) |> ignore
    let observed = gate.WithRead(fun () -> shared.Value)
    if observed <> 5 then failwith "写区结果未被读区观察到")

report "hidden/nested-sequential-use-keeps-counts" (fun () ->
    let gate = Gate()
    for index in 1 .. 200 do
        let read = gate.WithRead(fun () -> index)
        if read <> index then failwith "读区返回值不正确"
        let write = gate.WithWrite(fun () -> index * 2)
        if write <> index * 2 then failwith "写区返回值不正确"
    let snapshot = gate.Snapshot()
    if snapshot.Readers <> 0 || snapshot.Writers <> 0 then failwith ("计数未回到 0：" + sprintf "%A" snapshot))

report "hidden/notification-exception-keeps-gate-usable" (fun () ->
    let gate = Gate()
    expectThrew "通知抛异常" (attempt 3000 (fun () -> gate.WithWriteThen((fun () -> 1), (fun _ -> failwith "通知失败"))))
    let value = expectOk "通知异常后的写入" (attempt 3000 (fun () -> gate.WithWrite(fun () -> 42)))
    if value <> 42 then failwith "通知异常后锁不可用")

report "hidden/queued-writer-precedes-new-reader" (fun () ->
    let gate = Gate()
    use initialEntered = new ManualResetEventSlim(false)
    use releaseInitial = new ManualResetEventSlim(false)
    use newcomerStarted = new ManualResetEventSlim(false)
    let order = ConcurrentQueue<string>()
    let failures = ConcurrentBag<string>()
    let threads = ResizeArray<Thread>()
    let start work = threads.Add(startThread (fun () -> try work () with error -> failures.Add(error.Message)))
    try
        start (fun () -> gate.WithRead(fun () -> initialEntered.Set(); releaseInitial.Wait(10000) |> ignore))
        if not (initialEntered.Wait(3000)) then failwith "首个读者未进入"
        start (fun () -> gate.WithWrite(fun () -> order.Enqueue("writer")))
        if not (SpinWait.SpinUntil((fun () -> gate.Snapshot().Waiters > 0), 3000)) then failwith "未报告等待写者"
        start (fun () -> newcomerStarted.Set(); gate.WithRead(fun () -> order.Enqueue("reader")))
        if not (newcomerStarted.Wait(3000)) then failwith "新读者未启动"
        releaseInitial.Set()
        if not (joinWithin 10000 (List.ofSeq threads)) then failwith "等待中的线程未完成"
        expectNoFailures "写者优先" failures
        if List.ofSeq order <> [ "writer"; "reader" ] then failwith "新读者越过了等待写者"
    finally
        releaseInitial.Set()
        joinWithin 10000 (List.ofSeq threads) |> ignore)

printfn "# passed %d failed %d" passed failed
if failed > 0 then exit 1
