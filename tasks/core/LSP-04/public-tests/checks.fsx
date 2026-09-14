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

report "public/state-staging-invisible" (fun () ->
    let index = Index()
    seed index "w"
    let ticket = index.Begin("w", 1, ["a"; "b"])
    index.Stage(ticket, "a", Some ["new-a"]) |> ignore
    equal ["old-a"] (index.Snapshot("w").["a"])
    equal false (index.Publish(ticket))
    index.Stage(ticket, "b", Some ["new-b"]) |> ignore
    equal true (index.Publish(ticket))
    equal ["new-b"] (index.Snapshot("w").["b"])
)

report "public/state-generation-isolation" (fun () ->
    let index = Index()
    let old = index.Begin("w", 1, ["a"])
    let current = index.Begin("w", 2, ["a"])
    equal true old.Token.IsCancellationRequested
    equal false (index.Stage(old, "a", Some ["old"]))
    equal false (index.Publish(old))
    equal true (index.Stage(current, "a", Some ["new"]))
    equal true (index.Publish(current))
)

report "public/incremental-delete" (fun () ->
    let index = Index()
    seed index "w"
    let ticket = index.Begin("w", 1, ["a"])
    index.Stage(ticket, "a", None) |> ignore
    equal true (index.Publish(ticket))
    equal (Map.ofList ["b", ["old-b"]]) (index.Snapshot("w"))
)

if failures > 0 then exit 1
