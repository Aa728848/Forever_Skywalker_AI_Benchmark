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

report "public/cancel-and-stale-result" (fun () ->
    let c = Coordinator()
    let old = c.Start("a", 1)
    let newer = c.Start("a", 2)
    equal true old.Token.IsCancellationRequested
    equal false (c.Complete(old, ["old"]))
    equal true (c.Complete(newer, ["new"]))
    equal ["new"] (c.Published("a"))
)

report "public/state-close-reopen" (fun () ->
    let c = Coordinator()
    let old = c.Start("a", 9)
    c.Close("a")
    let fresh = c.Start("a", 1)
    equal true old.Token.IsCancellationRequested
    equal false (c.Complete(old, ["old"]))
    equal true (c.Complete(fresh, ["fresh"]))
)

report "public/version-rejection" (fun () ->
    let c = Coordinator()
    c.Start("a", 4) |> ignore
    let rejected = try c.Start("a", 3) |> ignore; false with :? ArgumentException -> true
    equal true rejected
)

if failures > 0 then exit 1
