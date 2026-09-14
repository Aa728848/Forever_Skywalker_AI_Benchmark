export interface Vertex { readonly id: string; readonly dependencies: readonly string[] }
export interface Stats { readonly nodes: number; readonly edges: number; readonly inDegree: ReadonlyMap<string,number>; readonly roots: readonly string[]; readonly missing: readonly string[] }
export function graphStats(vertices: readonly Vertex[]): Stats {
  const ids=new Set(vertices.map(v=>v.id));if(ids.size!==vertices.length)throw new RangeError('duplicate vertex');
  // 缺陷：对每个顶点重新扫描所有边，稀疏图也退化为平方成本。
  const degree=new Map(vertices.map(v=>[v.id,vertices.reduce((n,source)=>n+(new Set(source.dependencies).has(v.id)?1:0),0)]));
  const missing=new Set(vertices.flatMap(v=>v.dependencies).filter(id=>!ids.has(id)));
  return {nodes:vertices.length,edges:[...degree.values()].reduce((a,b)=>a+b,0),inDegree:degree,roots:[...degree].filter(([,n])=>n===0).map(([id])=>id).sort(),missing:[...missing].sort()};
}
