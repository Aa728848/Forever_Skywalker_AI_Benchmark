module DocumentEdits

type Position = { Line: int; Character: int }
type Span = { Start: Position; Finish: Position }
type Edit = { Range: Span option; Text: string }
type Document = { Text: string; Version: int }

let private locate (text: string) (position: Position) =
    if position.Line < 0 || position.Character < 0 then failwith "range"
    let mutable index, line = 0, 0
    while line < position.Line && index < text.Length do
        if text.[index] = '\n' then line <- line + 1
        index <- index + 1
    if line <> position.Line then failwith "range"
    let mutable finish = index
    while finish < text.Length && text.[finish] <> '\n' do finish <- finish + 1
    let limit = if finish > index && text.[finish - 1] = '\r' then finish - 1 else finish
    if index + position.Character > limit then failwith "range"
    index + position.Character
let apply (document: Document) version (edits: Edit list) =
    if version <= document.Version then Error "stale version"
    else
        try
            let update text edit =
                match edit.Range with
                | None -> edit.Text
                | Some range ->
                    let first, finish = locate text range.Start, locate text range.Finish
                    if first > finish then failwith "range"
                    (text: string).Remove(first, finish - first).Insert(first, edit.Text)
            Ok { Text = List.fold update document.Text edits; Version = version }
        with _ -> Error "invalid range"
