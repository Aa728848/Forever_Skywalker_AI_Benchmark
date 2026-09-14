module Diagnostics
open System
open System.Threading
open System.Collections.Generic

type Request = { Id: int; Uri: string; Version: int; Token: CancellationToken }

type Coordinator() =
    let gate = obj()
    let mutable next = 0
    let mutable state : Map<string, int * (Request * CancellationTokenSource) option * string list> = Map.empty
    member _.Start(uri, version) = lock gate (fun () ->
        let previous = Map.tryFind uri state
        match previous with
        | Some (oldVersion, _, _) when version <= oldVersion -> invalidArg "version" "stale version"
        | _ -> ()
        match previous with
        | Some (_, Some (_, source), _) -> source.Cancel(); source.Dispose()
        | _ -> ()
        next <- next + 1
        let source = new CancellationTokenSource()
        let request = { Id = next; Uri = uri; Version = version; Token = source.Token }
        let visible = match previous with | Some (_, _, value) -> value | None -> []
        state <- Map.add uri (version, Some (request, source), visible) state
        request)
    member _.Complete(request: Request, diagnostics: string list) = lock gate (fun () ->
        match Map.tryFind request.Uri state with
        | Some (version, Some (ticket, source), _) when ticket.Id = request.Id ->
            source.Dispose()
            state <- Map.add request.Uri (version, None, diagnostics) state
            true
        | _ -> false)
    member _.Close(uri) = lock gate (fun () ->
        match Map.tryFind uri state with
        | Some (_, Some (_, source), _) -> source.Cancel(); source.Dispose()
        | _ -> ()
        state <- Map.remove uri state)
    member _.Published(uri) = lock gate (fun () ->
        match Map.tryFind uri state with | Some (_, _, value) -> value | _ -> [])
