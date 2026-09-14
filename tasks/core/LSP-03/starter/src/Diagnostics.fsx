module Diagnostics
open System
open System.Threading
open System.Collections.Generic

type Request = { Id: int; Uri: string; Version: int; Token: CancellationToken }

type Coordinator() =
    let gate = obj()
    let active = Dictionary<string, Request * CancellationTokenSource>()
    let versions = Dictionary<string, int>()
    let published = Dictionary<string, string list>()
    let mutable sequence = 0
    member _.Start(uri, version) = lock gate (fun () ->
        if versions.ContainsKey(uri) && version <= versions.[uri] then invalidArg "version" "stale version"
        match active.TryGetValue(uri) with
        | true, (_, source) -> source.Dispose()
        | _ -> ()
        sequence <- sequence + 1
        let source = new CancellationTokenSource()
        let request = { Id = sequence; Uri = uri; Version = version; Token = source.Token }
        active.[uri] <- (request, source)
        versions.[uri] <- version
        request)
    member _.Complete(request: Request, diagnostics: string list) = lock gate (fun () ->
        match active.TryGetValue(request.Uri) with
        | true, (_, source) ->
            published.[request.Uri] <- diagnostics
            active.Remove(request.Uri) |> ignore
            source.Dispose()
            true
        | _ -> false)
    member _.Close(uri) = lock gate (fun () ->
        match active.TryGetValue(uri) with
        | true, (_, source) -> source.Cancel(); source.Dispose(); active.Remove(uri) |> ignore
        | _ -> ()
        versions.Remove(uri) |> ignore
        published.Remove(uri) |> ignore)
    member _.Published(uri) = lock gate (fun () ->
        match published.TryGetValue(uri) with | true, value -> value | _ -> [])
