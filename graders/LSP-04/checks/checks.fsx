#load "../starter/src/WorkspaceIndex.fsx"
open System
open System.Threading
open System.Threading.Tasks
open WorkspaceIndex
let mutable failures = 0
let mutable counter = 0
let report name work =
    counter <- counter + 1
    try work (); printfn "ok %d - %s" counter name
    with error -> failures <- failures + 1; printfn "not ok %d - %s" counter name; printfn "# %s" error.Message
let equal expected actual = if expected <> actual then failwithf "expected %A, got %A" expected actual
let seed (index: Index) workspace =
    let ticket = index.Begin(workspace, 0, ["a"; "b"])
    index.Stage(ticket, "a", Some ["old-a"]) |> ignore
    index.Stage(ticket, "b", Some ["old-b"]) |> ignore
    equal true (index.Publish(ticket))

report "hidden/state-abort-preserves-snapshot" (fun () ->
    let index = Index()
    seed index "a"
    seed index "b"
    let before = index.Snapshot("a")
    let ticket = index.Begin("a", 1, ["a"])
    index.Stage(ticket, "a", Some ["unconfirmed"]) |> ignore
    index.Abort(ticket)
    equal true ticket.Token.IsCancellationRequested
    equal false (index.Publish(ticket))
    equal before (index.Snapshot("a"))
    equal before (index.Snapshot("b"))
)

report "hidden/resource-parallel-staging" (fun () ->
    let index = Index()
    let paths = [ for i in 1 .. 64 -> string i ]
    let ticket = index.Begin("w", 1, paths)
    let run path = Task.Run(Action(fun () -> equal true (index.Stage(ticket, path, Some [path]))))
    let tasks = paths |> List.map run |> List.toArray
    if not (Task.WaitAll(tasks, 10000)) then failwith "stage timeout"
    equal Map.empty (index.Snapshot("w"))
    equal true (index.Publish(ticket))
    equal (Map.ofList (paths |> List.map (fun path -> path, [path]))) (index.Snapshot("w"))
)

report "hidden/boundary-undeclared-and-stale" (fun () ->
    let index = Index()
    let ticket = index.Begin("w", 2, ["a"])
    let rejected = try index.Stage(ticket, "outside", Some []) |> ignore; false with :? ArgumentException -> true
    equal true rejected
    let stale = try index.Begin("w", 1, []) |> ignore; false with :? ArgumentException -> true
    equal true stale
    equal false (index.Publish(ticket))
)


report "hidden/document-version-and-duplicate-result" (fun () ->
    let index=Index()
    let ticket=index.BeginWithVersions("w",1,Map.ofList ["a",4;"b",9])
    equal false (index.StageVersioned(ticket,"a",3,Some ["stale"]))
    equal true (index.StageVersioned(ticket,"a",4,Some ["a4"]))
    equal false (index.StageVersioned(ticket,"a",4,Some ["late duplicate"]))
    equal false (index.Publish(ticket))
    equal true (index.StageVersioned(ticket,"b",9,None))
    equal true (index.Publish(ticket))
    equal {Symbols=Map.ofList ["a",["a4"]];Versions=Map.ofList ["a",4]} (index.View("w"))
)
report "hidden/readers-observe-atomic-versioned-view" (fun () ->
    let index=Index()
    let errors=System.Collections.Concurrent.ConcurrentQueue<string>()
    use stop=new CancellationTokenSource()
    use started=new ManualResetEventSlim(false)
    let reader=Task.Run(Action(fun () ->
      started.Set()
      while not stop.IsCancellationRequested do
        let view=index.View("w")
        if view.Symbols.Count<>view.Versions.Count then errors.Enqueue("split view")
        for KeyValue(path,version) in view.Versions do
            if Map.tryFind path view.Symbols<>Some [string version] then errors.Enqueue("version mismatch")))
    if not(started.Wait(3000)) then failwith "reader did not start"
    try
        for generation in 0..24 do
            let ticket=index.BeginWithVersions("w",generation,Map.ofList ["a",generation;"b",generation])
            equal true (index.StageVersioned(ticket,"a",generation,Some [string generation]))
            equal true (index.StageVersioned(ticket,"b",generation,Some [string generation]))
            equal true (index.Publish(ticket))
        equal 2 (index.View("w").Versions.Count)
    finally stop.Cancel(); if not(reader.Wait(3000)) then failwith "reader did not stop"
    equal true errors.IsEmpty
)
report "hidden/close-callback-reopen-and-foreign-ticket" (fun () ->
    let index=Index()
    let ticket=index.Begin("w",1,["a"])
    let mutable reopened:Build option=None
    use registration=ticket.Token.Register(Action(fun () ->
        let observer=Task.Run(fun () -> index.View("w"))
        if not(observer.Wait(2000)) then failwith "close callback held gate"
        reopened<-Some(index.Begin("w",0,[]))))
    index.Close("w")
    equal true reopened.IsSome
    equal true (index.Publish(reopened.Value))
    equal false (index.Stage(ticket,"a",Some ["late"]))
    let other=Index()
    let owner=Index()
    let own=owner.Begin("x",2,["a"])
    let foreign=other.Begin("x",2,["a"])
    equal false (owner.Stage(foreign,"a",Some ["foreign"]))
    equal true (owner.Stage(own,"a",Some ["own"]))
)

if failures > 0 then exit 1
