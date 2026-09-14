module FrameParser

open System
open System.Text

let private parseContentLength (header: string) : Result<int, string> =
    let lines = header.Split([| "\r\n" |], StringSplitOptions.None)
    let mutable missing = true
    let mutable invalid = false
    let mutable length = 0
    for line in lines do
        let trimmed = line.Trim()
        if trimmed <> "" then
            let separator = trimmed.IndexOf(':')
            if separator > 0 then
                let name = trimmed.Substring(0, separator).Trim().ToLowerInvariant()
                if name = "content-length" then
                    let value = trimmed.Substring(separator + 1).Trim()
                    match Int32.TryParse(value) with
                    | true, parsed when parsed >= 0 ->
                        missing <- false
                        length <- parsed
                    | _ ->
                        missing <- false
                        invalid <- true
    if invalid then Error "invalid content-length"
    elif missing then Error "missing content-length"
    else Ok length

/// 先把缓冲解码成字符串，再按头部空行切分。
let parseFrames (buffer: byte[]) : Result<string list * byte[], string> =
    let text = Encoding.UTF8.GetString(buffer)
    let parts = text.Split([| "\r\n\r\n" |], StringSplitOptions.None)
    let bodies = ResizeArray<string>()
    let mutable problem = None
    let mutable index = 0
    while problem.IsNone && index + 1 < parts.Length do
        match parseContentLength parts.[index] with
        | Error message -> problem <- Some message
        | Ok length ->
            let body = parts.[index + 1]
            if length <= body.Length then
                bodies.Add(body.Substring(0, length))
            index <- index + 2
    match problem with
    | Some message -> Error message
    | None -> Ok (List.ofSeq bodies, [||])

