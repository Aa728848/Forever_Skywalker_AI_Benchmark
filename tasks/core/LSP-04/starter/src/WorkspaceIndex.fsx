module WorkspaceIndex
open System
open System.Threading

type Build = { Id: int; Workspace: string; Generation: int; Token: CancellationToken }
type View = { Symbols:Map<string,string list>; Versions:Map<string,int> }
type private Pending = { Ticket: Build; Expected: Set<string>; Changes: Map<string, string list option>; Source: CancellationTokenSource }

type Index() =
    let gate = obj()
    let mutable next = 0
    let mutable pending : Map<string, Pending> = Map.empty
    let mutable versions : Map<string, int> = Map.empty
    let mutable visible : Map<string, Map<string, string list>> = Map.empty
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
            // 缺陷：分批构建直接改已发布索引，失败与取消前已泄漏半成品。
            let currentVisible = Map.tryFind ticket.Workspace visible |> Option.defaultValue Map.empty
            visible <- Map.add ticket.Workspace (match symbols with | Some value -> Map.add path value currentVisible | None -> Map.remove path currentVisible) visible
            pending <- Map.add ticket.Workspace { current with Changes = Map.add path symbols current.Changes } pending
            true
        | _ -> false)
    member _.Publish(ticket: Build) = lock gate (fun () ->
        match Map.tryFind ticket.Workspace pending with
        | Some current when current.Ticket.Id = ticket.Id ->
            let previous = Map.tryFind ticket.Workspace visible |> Option.defaultValue Map.empty
            let result = Map.fold (fun index path symbols -> match symbols with | Some value -> Map.add path value index | None -> Map.remove path index) previous current.Changes
            visible <- Map.add ticket.Workspace result visible
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
    member _.Snapshot(workspace) = lock gate (fun () -> Map.tryFind workspace visible |> Option.defaultValue Map.empty)

    member this.BeginWithVersions(workspace,generation,expected:Map<string,int>) = this.Begin(workspace,generation,expected |> Map.toList |> List.map fst)
    member this.StageVersioned(ticket:Build,path,version:int,symbols) = this.Stage(ticket,path,symbols)
    member this.View(workspace):View = {Symbols=this.Snapshot(workspace);Versions=Map.empty}
    member _.Close(workspace) = ()
