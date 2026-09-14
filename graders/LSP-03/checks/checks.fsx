#load "../starter/src/Diagnostics.fsx"
open Diagnostics
open System
open System.Threading
open System.Threading.Tasks
let mutable failures = 0
let mutable counter = 0
let report name work =
    counter <- counter + 1
    try work (); printfn "ok %d - %s" counter name
    with error -> failures <- failures + 1; printfn "not ok %d - %s" counter name; printfn "# %s" error.Message
let equal expected actual = if expected <> actual then failwithf "expected %A, got %A" expected actual

report "hidden/independent-documents" (fun () ->
    let c = Coordinator()
    let a = c.Start("a", 1)
    let b = c.Start("b", 1)
    c.Start("a", 2) |> ignore
    equal false b.Token.IsCancellationRequested
    equal true (c.Complete(b, ["b"]))
    equal false (c.Complete(a, ["a"]))
)

report "hidden/state-once-and-published-retained" (fun () ->
    let c = Coordinator()
    let first = c.Start("a", 1)
    equal true (c.Complete(first, ["confirmed"]))
    let next = c.Start("a", 2)
    equal ["confirmed"] (c.Published("a"))
    equal false (c.Complete(first, ["duplicate"]))
    equal ["confirmed"] (c.Published("a"))
    equal true (c.Complete(next, ["final"]))
    c.Close("a")
    equal [] (c.Published("a"))
)

report "hidden/resource-parallel-publication" (fun () ->
    let c = Coordinator()
    let run i =
        Task.Run(Action(fun () ->
            let uri = string i
            let request = c.Start(uri, 1)
            if not (c.Complete(request, [uri])) then failwith "publish lost"))
    let work = [| 1 .. 40 |] |> Array.map run
    if not (Task.WaitAll(work, 10000)) then failwith "parallel timeout"
    for i in 1 .. 40 do equal [string i] (c.Published(string i))
)

if failures > 0 then exit 1
