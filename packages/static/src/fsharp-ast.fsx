// Trusted FSharp.Compiler.Service parser; candidate files are never #load'ed or executed.
open System
open System.Collections
open System.IO
open System.Text.Json
open Microsoft.FSharp.Reflection
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Diagnostics
open FSharp.Compiler.Syntax
open FSharp.Compiler.Text

type FunctionFacts = { name: string; lines: int; decisionPoints: int }
type Facts = { functions: FunctionFacts array; imports: string array }

let file = fsi.CommandLineArgs[1]
let checker = FSharpChecker.Create()
let options = { FSharpParsingOptions.Default with SourceFiles = [| file |]; IsInteractive = Path.GetExtension(file) = ".fsx" }
let parsed = checker.ParseFile(file, SourceText.ofString(File.ReadAllText(file)), options) |> Async.RunSynchronously
if parsed.Diagnostics |> Array.exists (fun item -> item.Severity = FSharpDiagnosticSeverity.Error) then
    eprintfn "F# syntax error: %s" ((parsed.Diagnostics |> Array.map (fun item -> item.Message)) |> String.concat "; ")
    exit 1

let fields (value: obj) =
    if isNull value || value :? string then [||]
    elif value :? IEnumerable then (value :?> IEnumerable) |> Seq.cast<obj> |> Seq.toArray
    elif FSharpType.IsUnion(value.GetType()) then FSharpValue.GetUnionFields(value, value.GetType()) |> snd
    elif FSharpType.IsRecord(value.GetType()) then FSharpValue.GetRecordFields(value)
    else [||]

let bindingName (SynBinding(headPat = pattern; expr = expr)) =
    match pattern with
    | SynPat.LongIdent(longDotId = id; argPats = SynArgPats.Pats args) when not args.IsEmpty ->
        Some(id.LongIdent |> List.map (fun item -> item.idText) |> String.concat ".")
    | SynPat.Named(ident = SynIdent(ident, _)) ->
        match expr with
        | SynExpr.Lambda _ | SynExpr.MatchLambda _ -> Some ident.idText
        | _ -> None
    | _ -> None

let decisions (root: SynExpr) =
    let pending = Collections.Generic.Stack<obj>()
    pending.Push(root)
    let mutable count = 0
    while pending.Count > 0 do
        let value = pending.Pop()
        match value with
        | :? SynBinding as binding when bindingName binding |> Option.isSome -> () // Nested functions have their own measurement.
        | :? SynExpr as expr when not (obj.ReferenceEquals(expr, root)) && (match expr with SynExpr.Lambda _ -> true | _ -> false) -> ()
        | _ ->
            match value with
            | :? SynExpr as expr ->
                match expr with
                | SynExpr.IfThenElse _ | SynExpr.For _ | SynExpr.ForEach _ | SynExpr.While _ -> count <- count + 1
                | SynExpr.Match(clauses = clauses) -> count <- count + max 0 (clauses.Length - 1)
                | SynExpr.MatchLambda(matchClauses = clauses) -> count <- count + max 0 (clauses.Length - 1)
                | SynExpr.TryWith(withCases = clauses) -> count <- count + clauses.Length
                | SynExpr.Ident ident when ident.idText = "op_BooleanAnd" || ident.idText = "op_BooleanOr" -> count <- count + 1
                | SynExpr.LongIdent(longDotId = id) when id.LongIdent |> List.exists (fun ident -> ident.idText = "op_BooleanAnd" || ident.idText = "op_BooleanOr") -> count <- count + 1
                | _ -> ()
            | _ -> ()
            for child in fields value do pending.Push(child)
    count

let functions = Collections.Generic.List<FunctionFacts>()
let imports = Collections.Generic.List<string>()
let namedBodies = Collections.Generic.HashSet<SynExpr>(HashIdentity.Reference)
let pending = Collections.Generic.Stack<obj>()
pending.Push(parsed.ParseTree)
while pending.Count > 0 do
    let value = pending.Pop()
    match value with
    | :? SynBinding as binding ->
        let (SynBinding(headPat = pattern; expr = expr)) = binding
        match bindingName binding with
        | Some name ->
            namedBodies.Add(expr) |> ignore
            functions.Add { name = name; lines = expr.Range.EndLine - pattern.Range.StartLine + 1; decisionPoints = decisions expr }
        | None -> ()
    | :? SynExpr as expr ->
        match expr with
        | SynExpr.Lambda _ | SynExpr.MatchLambda _ when not (namedBodies.Contains(expr)) ->
            functions.Add { name = "anonymous"; lines = expr.Range.EndLine - expr.Range.StartLine + 1; decisionPoints = decisions expr }
        | _ -> ()
    | :? SynModuleDecl as declaration ->
        match declaration with
        | SynModuleDecl.Open(target = SynOpenDeclTarget.ModuleOrNamespace(longId, _)) ->
            imports.Add(longId.LongIdent |> List.map (fun item -> item.idText) |> String.concat ".")
        | _ -> ()
    | _ -> ()
    for child in fields value |> Array.rev do pending.Push(child)

printfn "%s" (JsonSerializer.Serialize { functions = functions.ToArray(); imports = imports.ToArray() })
