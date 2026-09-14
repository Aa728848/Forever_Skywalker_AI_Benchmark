module WorkspaceIndex
open System
open System.Threading
open System.Collections.Generic
type Build = { Id:int; Workspace:string; Generation:int; Token:CancellationToken }
type View = { Symbols:Map<string,string list>; Versions:Map<string,int> }
type private Pending = { Ticket:Build; Expected:Map<string,int>; Changes:Map<string,string list option>; Source:CancellationTokenSource }
type Index() =
    let gate=obj()
    let empty = {Symbols=Map.empty;Versions=Map.empty}
    let mutable next=0
    let pending = Dictionary<string,Pending>()
    let generations = Dictionary<string,int>()
    let visible = Dictionary<string,View>()
    let get key (source:Dictionary<string,'T>) = match source.TryGetValue(key) with | true,value -> Some value | _ -> None
    let cancel prior = prior |> Option.iter(fun (state:Pending) -> try state.Source.Cancel() finally state.Source.Dispose())
    let beginBuild workspace generation expected =
        let ticket,prior = lock gate (fun () ->
            if generation < 0 || (get workspace generations |> Option.exists(fun old -> generation<=old)) then invalidArg "generation" "stale generation"
            if expected |> Map.exists(fun _ version -> version<0) then invalidArg "expected" "negative document version"
            let prior=get workspace pending
            next<-next+1
            let source=new CancellationTokenSource()
            let ticket={Id=next;Workspace=workspace;Generation=generation;Token=source.Token}
            pending.[workspace]<-{Ticket=ticket;Expected=expected;Changes=Map.empty;Source=source}
            generations.[workspace]<-generation
            ticket,prior)
        cancel prior
        ticket
    let stage ticket path version symbols = lock gate (fun () ->
        match get ticket.Workspace pending with
        | Some current when current.Ticket=ticket ->
            if not(Map.containsKey path current.Expected) then invalidArg "path" "unexpected document"
            if version<>current.Expected.[path] || Map.containsKey path current.Changes then false
            else
                pending.[ticket.Workspace]<-{current with Changes=Map.add path symbols current.Changes}
                true
        | _ -> false)
    member _.Begin(workspace,generation,expected:string list) = beginBuild workspace generation (expected |> List.map(fun path->path,generation) |> Map.ofList)
    member _.BeginWithVersions(workspace,generation,expected:Map<string,int>) = beginBuild workspace generation expected
    member _.StageVersioned(ticket:Build,path,version,symbols) = stage ticket path version symbols
    member _.Stage(ticket:Build,path,symbols) = lock gate (fun () ->
        match get ticket.Workspace pending with
        | Some current when current.Ticket=ticket ->
            if not(Map.containsKey path current.Expected) then invalidArg "path" "unexpected document"
            stage ticket path current.Expected.[path] symbols
        | _ -> false)
    member _.Publish(ticket:Build) = lock gate (fun () ->
        match get ticket.Workspace pending with
        | Some current when current.Ticket=ticket && current.Changes.Count=current.Expected.Count ->
            let previous=get ticket.Workspace visible |> Option.defaultValue empty
            let result=Map.fold(fun snapshot path symbols ->
                match symbols with
                | Some value -> {Symbols=Map.add path value snapshot.Symbols;Versions=Map.add path current.Expected.[path] snapshot.Versions}
                | None -> {Symbols=Map.remove path snapshot.Symbols;Versions=Map.remove path snapshot.Versions}) previous current.Changes
            visible.[ticket.Workspace]<-result
            pending.Remove(ticket.Workspace) |> ignore
            current.Source.Dispose()
            true
        | _ -> false)
    member _.Abort(ticket:Build) =
        let prior=lock gate (fun () ->
            match get ticket.Workspace pending with
            | Some current when current.Ticket=ticket -> pending.Remove(ticket.Workspace) |> ignore;Some current
            | _ -> None)
        cancel prior
    member _.Close(workspace) =
        let prior=lock gate (fun () ->
            let prior=get workspace pending
            pending.Remove(workspace) |> ignore
            generations.Remove(workspace) |> ignore
            visible.Remove(workspace) |> ignore
            prior)
        cancel prior
    member _.View(workspace):View = lock gate (fun () -> get workspace visible |> Option.defaultValue empty)
    member this.Snapshot(workspace) = (this.View(workspace)).Symbols
