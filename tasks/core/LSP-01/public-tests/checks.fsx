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

report "public/parses-single-ascii-message" (fun () ->
    expectBodies [ "body" ] [||] (parseFrames (bytes (frame "body"))))

report "public/parses-multiple-concatenated-messages" (fun () ->
    expectBodies [ "one"; "two" ] [||] (parseFrames (bytes (frame "one" + frame "two"))))

report "public/keeps-incomplete-tail" (fun () ->
    let partial = "Content-Length: 10\r\n\r\nabc"
    expectBodies [ "done" ] (bytes partial) (parseFrames (bytes (frame "done" + partial))))

report "public/multibyte-body-uses-byte-length" (fun () ->
    let body = "中文内容"
    expectBodies [ body ] [||] (parseFrames (bytes (frame body))))

report "public/rejects-missing-content-length" (fun () ->
    expectError "missing content-length" (parseFrames (bytes "Content-Type: application/json\r\n\r\nbody")))

report "public/rejects-invalid-content-length" (fun () ->
    expectError "invalid content-length" (parseFrames (bytes "Content-Length: abc\r\n\r\nbody"))
    expectError "invalid content-length" (parseFrames (bytes "Content-Length: -3\r\n\r\nbody")))

report "public/header-name-is-case-insensitive" (fun () ->
    expectBodies [ "payload" ] [||] (parseFrames (bytes "content-length: 7\r\n\r\npayload")))

printfn "# passed %d failed %d" passed failed
if failed > 0 then exit 1

