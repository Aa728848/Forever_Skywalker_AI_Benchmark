export interface Vertex { readonly id: string; readonly dependencies: readonly string[] }
export interface Stats { readonly nodes: number; readonly edges: number; readonly inDegree: ReadonlyMap<string,number>; readonly roots: readonly string[]; readonly missing: readonly string[] }
export function graphStats(vertices: readonly Vertex[]): Stats {
  const ids=vertices.map(vertex=>vertex.id);const positions=new Map(ids.map((id,index)=>[id,index]));
  if(positions.size!==ids.length)throw new RangeError('duplicate vertex');
  const counts=new Uint32Array(ids.length);const absent=new Set<string>();let edgeCount=0;
  for(let i=0;i<vertices.length;i++){
    const seen=new Set<string>();for(const dependency of vertices[i].dependencies){if(seen.has(dependency))continue;seen.add(dependency);const at=positions.get(dependency);if(at===undefined)absent.add(dependency);else{counts[at]++;edgeCount++;}}
  }
  const inDegree=new Map(ids.map((id,index)=>[id,counts[index]]));
  return {nodes:ids.length,edges:edgeCount,inDegree,roots:ids.filter((_,index)=>counts[index]===0).sort(),missing:Array.from(absent).sort()};
}
