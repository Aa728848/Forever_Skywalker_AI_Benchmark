"""Trusted parser: parse candidate text as data, never import or execute it."""
import ast
import json
import pathlib
import sys

source = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8-sig")
tree = ast.parse(source, filename=sys.argv[1])
function_types = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)


def decisions(root):
    count = 0
    pending = list(ast.iter_child_nodes(root))
    while pending:
        node = pending.pop()
        if isinstance(node, function_types):
            continue
        if isinstance(node, (ast.If, ast.IfExp, ast.For, ast.AsyncFor, ast.While, ast.ExceptHandler)):
            count += 1
        elif isinstance(node, ast.BoolOp):
            count += len(node.values) - 1
        elif isinstance(node, ast.Match):
            count += max(0, len(node.cases) - 1)
        elif isinstance(node, ast.comprehension):
            count += 1 + len(node.ifs)
        pending.extend(ast.iter_child_nodes(node))
    return count


functions = []
imports = []
for node in ast.walk(tree):
    if isinstance(node, function_types):
        functions.append({"name": getattr(node, "name", "anonymous"), "lines": node.end_lineno - node.lineno + 1, "decisionPoints": decisions(node)})
    elif isinstance(node, ast.Import):
        imports.extend(alias.name for alias in node.names)
    elif isinstance(node, ast.ImportFrom):
        imports.append("." * node.level + (node.module or ""))
    elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "__import__":
        if node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
            imports.append(node.args[0].value)

print(json.dumps({"functions": functions, "imports": imports}))
