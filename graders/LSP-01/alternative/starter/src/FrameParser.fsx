module FrameParser

open System
open System.Text

let private parseContentLength (header: string) : Result<int, string> =
    let mutable outcome = None
    for line in header.Split([| "\r\n" |], StringSplitOptions.None) do
        let separator = line.IndexOf(':')
        if separator > 0 && line.Substring(0, separator).Trim().ToLowerInvariant() = "content-length" then
            let value = line.Substring(separator + 1).Trim()
            match Int32.TryParse(value) with
            | true, parsed when parsed >= 0 -> outcome <- Some (Ok parsed)
            | _ -> outcome <- Some (Error "invalid content-length")
    match outcome with
    | Some result -> result
    | None -> Error "missing content-length"

/// 替代实现：按行扫描头部（字节级），用 Sequence 累计消息并保留尾部。
let parseFrames (buffer: byte[]) : Result<string list * byte[], string> =
    let mutable index = 0
    let mutable problem = None
    let pending = ResizeArray<string>()
    let mutable consumed = 0
    let mutable scanning = true
    while scanning && problem.IsNone do
        // 找 \r\n\r\n
        let mutable headerEnd = -1
        let mutable probe = index
        while headerEnd < 0 && probe <= buffer.Length - 4 do
            if buffer.[probe] = 13uy && buffer.[probe + 1] = 10uy && buffer.[probe + 2] = 13uy && buffer.[probe + 3] = 10uy then headerEnd <- probe
            probe <- probe + 1
        if headerEnd < 0 then scanning <- false
        else
            match parseContentLength (Encoding.ASCII.GetString(buffer, index, headerEnd - index)) with
            | Error message -> problem <- Some message
            | Ok length ->
                let start = headerEnd + 4
                if start + length > buffer.Length then scanning <- false
                else
                    pending.Add(Encoding.UTF8.GetString(buffer, start, length))
                    consumed <- start + length
                    index <- consumed
    match problem with
    | Some message -> Error message
    | None -> Ok (List.ofSeq pending, buffer.[consumed ..])

