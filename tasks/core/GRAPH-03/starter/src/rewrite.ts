import { InvalidNodeError, type AstNode } from './ast.ts';

/** 验证和调度独立于转换，回调只能看到已经转换的子节点。 */
export function rewriteAst(root: AstNode, transform: (node: AstNode) => string): AstNode {
  const state = new Map<AstNode, number>();
  const order: AstNode[] = [];
  const stack: Array<{node: AstNode; path: string; exit: boolean}> = [{node: root, path: 'root', exit: false}];
  while (stack.length) {
    const {node,path,exit} = stack.pop()!;
    if (exit) { state.set(node, 2); order.push(node); continue; }
    if (typeof node !== 'object' || node === null || typeof node.type !== 'string' || !node.type.length) throw new InvalidNodeError(path);
    if (state.get(node) === 1) throw new InvalidNodeError(path);
    if (state.get(node) === 2) continue;
    if (node.children !== undefined && !Array.isArray(node.children)) throw new InvalidNodeError(path+'.children');
    state.set(node, 1); stack.push({node,path,exit:true});
    const children=node.children??[];
    for(let i=children.length-1;i>=0;i--)stack.push({node:children[i]!,path:path+'.children['+i+']',exit:false});
  }
  const outputs = new Map<AstNode,AstNode>();
  for (const node of order) {
    const children = (node.children??[]).map(child=>outputs.get(child)!);
    const type = transform(node);
    if (typeof type !== 'string' || !type.length) throw new TypeError('transform must return a nonempty type');
    const result = node.children===undefined ? {type} : {type,children};
    outputs.set(node,result);
  }
  return outputs.get(root)!;
}
