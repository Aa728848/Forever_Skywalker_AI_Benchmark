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

report "hidden/boundary-crlf" (fun () ->
    equal (Ok (doc "a\r\n新\r\n" 2)) (apply (doc "a\r\nb\r\n" 1) 2 [edit (p 1 0) (p 1 1) "新"])
    equal (Error "invalid range") (apply (doc "a\r\nb" 1) 2 [edit (p 0 2) (p 0 2) "x"])
)

report "hidden/state-atomic-batch" (fun () ->
    let original = doc "ab\ncd" 8
    equal (Error "invalid range") (apply original 9 [edit (p 0 0) (p 0 1) "X"; edit (p 9 0) (p 9 1) "Y"])
    equal "ab\ncd" original.Text
)

report "hidden/boundary-reversed-empty" (fun () ->
    equal (Error "invalid range") (apply (doc "a\nb" 1) 2 [edit (p 1 0) (p 0 0) ""])
    equal (Ok (doc "a\n尾" 2)) (apply (doc "a\n" 1) 2 [edit (p 1 0) (p 1 0) "尾"])
    equal (Ok (doc "same" 6)) (apply (doc "same" 5) 6 [])
)

if failures > 0 then exit 1
