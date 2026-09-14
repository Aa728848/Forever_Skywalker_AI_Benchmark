#load "../starter/src/FrameParser.fsx"

open System
open System.Text
open FrameParser

let mutable passed = 0
let mutable failed = 0

let private report (name: string) (body: unit -> unit) =
    let number = passed + failed + 1
    try
        body ()
        passed <- passed + 1
        printfn "ok %d - %s" number name
    with error ->
        failed <- failed + 1
        printfn "not ok %d - %s" number name
        printfn "  ---"
        printfn "  error: %s" (error.Message.Replace("\n", " ").Replace("\r", " "))
        printfn "  ..."

let private bytes (text: string) : byte[] = Encoding.UTF8.GetBytes(text)

let private frame (body: string) : string =
    "Content-Length: " + string (Encoding.UTF8.GetByteCount(body)) + "\r\n\r\n" + body

let private expectBodies (expected: string list) (expectedTail: byte[]) (actual: Result<string list * byte[], string>) =
    match actual with
    | Error message -> failwith ("不应失败：" + message)
    | Ok (bodies, tail) ->
        if bodies <> expected then failwith ("消息体不匹配：期望 " + sprintf "%A" expected + "，实际 " + sprintf "%A" bodies)
        if tail <> expectedTail then failwith ("剩余字节不匹配：期望 " + sprintf "%A" expectedTail + "，实际 " + sprintf "%A" tail)

let private expectError (expected: string) (actual: Result<string list * byte[], string>) =
    match actual with
    | Ok (bodies, _) -> failwith ("应当失败，实际解析出 " + sprintf "%A" bodies)
    | Error message -> if message <> expected then failwith ("错误信息不匹配：期望 " + expected + "，实际 " + message)

report "hidden/byte-by-byte-stitching" (fun () ->
    let stream = bytes (frame "第一条" + frame "第二条")
    let mutable collected: string list = []
    let mutable buffer: byte[] = [||]
    for index in 0 .. stream.Length - 1 do
        buffer <- Array.append buffer [| stream.[index] |]
        match parseFrames buffer with
        | Error message -> failwith ("拼接过程中不应失败：" + message)
        | Ok (bodies, tail) ->
            collected <- collected @ bodies
            buffer <- tail
    if buffer.Length <> 0 then failwith ("拼接完成后不应有剩余字节")
    if collected <> [ "第一条"; "第二条" ] then failwith ("逐字节拼接结果不正确：" + sprintf "%A" collected))

report "hidden/multibyte-with-emoji" (fun () ->
    let body = "🚀 中文 🎯"
    expectBodies [ body ] [||] (parseFrames (bytes (frame body))))

report "hidden/missing-field-is-error" (fun () ->
    expectError "missing content-length" (parseFrames (bytes "X-Trace: 1\r\nY-Trace: 2\r\n\r\nbody")))

report "hidden/empty-body-is-valid" (fun () ->
    expectBodies [ "" ] [||] (parseFrames (bytes (frame ""))))

report "hidden/does-not-consume-complete-prefix" (fun () ->
    let partial = "Content-Length: 5\r\n"
    expectBodies [ "abc" ] (bytes partial) (parseFrames (bytes (frame "abc" + partial))))

printfn "# passed %d failed %d" passed failed
if failed > 0 then exit 1

