module WorkspaceIndex
open System
open System.Threading

type Build = { Id: int; Workspace: string; Generation: int; Token: CancellationToken }
type private Pending = { Ticket: Build; Expected: Set<string>; Changes: Map<string, string list option>; Source: CancellationTokenSource }

type Index() =
    let gate = obj()
    let mutable next = 0
    let mutable pending : Map<string, Pending> = Map.empty
    let mutable versions : Map<string, int> = Map.empty
    let visible = System.Collections.Generic.Dictionary<string, Map<string, string list>>()
    member _.Begin(workspace, generation, expected: string list) = lock gate (fun () ->
        if generation <= (Map.tryFind workspace versions |> Option.defaultValue -1) then invalidArg "generation" "stale generation"
        match Map.tryFind workspace pending with
        | Some prior -> prior.Source.Cancel(); prior.Source.Dispose()
        | None -> ()
        next <- next + 1
        let source = new CancellationTokenSource()
        let ticket = { Id = next; Workspace = workspace; Generation = generation; Token = source.Token }
        pending <- Map.add workspace { Ticket = ticket; Expected = Set.ofList expected; Changes = Map.empty; Source = source } pending
        versions <- Map.add workspace generation versions
        ticket)
    member _.Stage(ticket: Build, path, symbols) = lock gate (fun () ->
        match Map.tryFind ticket.Workspace pending with
        | Some current when current.Ticket.Id = ticket.Id ->
            if not (Set.contains path current.Expected) then invalidArg "path" "unexpected document"
            pending <- Map.add ticket.Workspace { current with Changes = Map.add path symbols current.Changes } pending
            true
        | _ -> false)
    member _.Publish(ticket: Build) = lock gate (fun () ->
        match Map.tryFind ticket.Workspace pending with
        | Some current when current.Ticket.Id = ticket.Id && current.Changes.Count = current.Expected.Count ->
            let previous = match visible.TryGetValue(ticket.Workspace) with | true, value -> value | _ -> Map.empty
            let mutable result = previous
            for KeyValue(path, symbols) in current.Changes do
                result <- match symbols with | None -> Map.remove path result | Some items -> Map.add path items result
            visible.[ticket.Workspace] <- result
            pending <- Map.remove ticket.Workspace pending
            current.Source.Dispose()
            true
        | _ -> false)
    member _.Abort(ticket: Build) = lock gate (fun () ->
        match Map.tryFind ticket.Workspace pending with
        | Some current when current.Ticket.Id = ticket.Id ->
            current.Source.Cancel(); current.Source.Dispose()
            pending <- Map.remove ticket.Workspace pending
        | _ -> ())
    member _.Snapshot(workspace) = lock gate (fun () -> match visible.TryGetValue(workspace) with | true, value -> value | _ -> Map.empty)
