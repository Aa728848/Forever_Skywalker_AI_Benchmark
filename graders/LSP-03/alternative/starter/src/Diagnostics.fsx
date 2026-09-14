module Diagnostics
open System
open System.Threading
type Request = { Id:int; Uri:string; Version:int; Token:CancellationToken }
type Coordinator() =
    let gate = obj()
    let mutable sequence = 0
    let mutable versions : Map<string,int> = Map.empty
    let mutable live : Map<string,Request * CancellationTokenSource> = Map.empty
    let mutable output : Map<string,string list> = Map.empty
    let retire old = old |> Option.iter (fun (_,source:CancellationTokenSource) -> try source.Cancel() finally source.Dispose())
    member _.Start(uri,version) =
        let request, old = lock gate (fun () ->
            if Map.tryFind uri versions |> Option.exists (fun previous -> version <= previous) then invalidArg "version" "stale version"
            let old = Map.tryFind uri live
            sequence <- sequence+1
            let source = new CancellationTokenSource()
            let request = { Id=sequence; Uri=uri; Version=version; Token=source.Token }
            versions <- Map.add uri version versions
            live <- Map.add uri (request,source) live
            request,old)
        retire old
        request
    member _.Complete(request:Request,diagnostics) = lock gate (fun () ->
        match Map.tryFind request.Uri live with
        | Some(current,source) when current=request ->
            output <- Map.add request.Uri diagnostics output
            live <- Map.remove request.Uri live
            source.Dispose()
            true
        | _ -> false)
    member _.Close(uri) =
        let old = lock gate (fun () ->
            let old = Map.tryFind uri live
            live <- Map.remove uri live
            versions <- Map.remove uri versions
            output <- Map.remove uri output
            old)
        retire old
    member _.Published(uri) = lock gate (fun () -> Map.tryFind uri output |> Option.defaultValue [])
