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

if failures > 0 then exit 1
