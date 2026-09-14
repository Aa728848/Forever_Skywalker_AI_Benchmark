import { InvalidNodeError, type AstNode } from './ast.ts';
export function rewriteAst(root: AstNode, transform: (node: AstNode) => string): AstNode {
  const seen=new Set<AstNode>();const active=new Set<AstNode>();const ordered:AstNode[]=[];
  const frames:Array<{node:AstNode;path:string;index:number}>=[];
  function enter(node:AstNode,path:string):void {
    if(typeof node!=='object'||node===null||typeof node.type!=='string'||node.type.length===0)throw new InvalidNodeError(path);
    if(active.has(node))throw new InvalidNodeError(path);
    if(seen.has(node))return;
    if(node.children!==undefined&&!Array.isArray(node.children))throw new InvalidNodeError(path+'.children');
    active.add(node);frames.push({node,path,index:0});
  }
  enter(root,'root');
  while(frames.length){const f=frames[frames.length-1]!;if(f.index<(f.node.children?.length??0)){const index=f.index++;enter(f.node.children![index]!,f.path+'.children['+index+']');}else{frames.pop();active.delete(f.node);seen.add(f.node);ordered.push(f.node);}}
  const result=new Map<AstNode,AstNode>();
  for(const node of ordered){const next=node.children?.map(child=>result.get(child)!);const input=Object.freeze(next===undefined?{type:node.type}:{type:node.type,children:Object.freeze(next)});const kind=transform(input);if(typeof kind!=='string'||kind.length===0)throw new TypeError('nonempty type required');let same=kind===node.type;if(next)for(let i=0;i<next.length;i++)if(next[i]!==node.children![i])same=false;result.set(node,same?node:next===undefined?{type:kind}:{type:kind,children:next});}
  return result.get(root)!;
}
