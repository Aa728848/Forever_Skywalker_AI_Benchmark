#load "../starter/src/DocumentEdits.fsx"
open DocumentEdits
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
let p line column : Position = { Line = line; Character = column }
let edit a b text : Edit = { Range = Some { Start = a; Finish = b }; Text = text }
let doc text version : Document = { Text = text; Version = version }

report "public/utf16-multiline" (fun () ->
    equal (Ok (doc "head\n😀B" 2)) (apply (doc "head\n😀A" 1) 2 [edit (p 1 2) (p 1 3) "B"])
)

report "public/state-version" (fun () ->
    equal (Error "stale version") (apply (doc "a" 4) 4 [{ Range = None; Text = "b" }])
)

report "public/sequential-edits" (fun () ->
    equal (Ok (doc "XYZ" 3)) (apply (doc "abc" 1) 3 [{ Range = None; Text = "XY" }; edit (p 0 2) (p 0 2) "Z"])
)

report "public/resource-large-document" (fun () ->
    let text = String.replicate 50000 "x\n"
    let before = GC.GetAllocatedBytesForCurrentThread()
    let clock = System.Diagnostics.Stopwatch.StartNew()
    let result = apply (doc text 1) 2 [edit (p 50000 0) (p 50000 0) "tail"]
    clock.Stop()
    let allocated = GC.GetAllocatedBytesForCurrentThread() - before
    equal (Ok (doc (text + "tail") 2)) result
    if clock.ElapsedMilliseconds >= 5000L then failwith "50000 行编辑超过 5000ms"
    if allocated >= 64L * 1024L * 1024L then failwith "50000 行编辑分配超过 64MiB"
)
if failures > 0 then exit 1
