module DocumentEdits

type Position = { Line: int; Character: int }
type Span = { Start: Position; Finish: Position }
type Edit = { Range: Span option; Text: string }
type Document = { Text: string; Version: int }

let apply (document: Document) version (edits: Edit list) =
    // 缺陷：忽略文档版本和行偏移，把列号当作全文下标。
    try
        let mutable text = document.Text
        for edit in edits do
            text <- match edit.Range with
                    | None -> edit.Text
                    | Some range -> text.Substring(0, range.Start.Character) + edit.Text + text.Substring(range.Finish.Character)
        Ok { Text = text; Version = version }
    with _ -> Error "invalid range"
