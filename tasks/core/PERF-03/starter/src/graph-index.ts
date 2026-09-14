import type {Stats} from './graph-stats.ts';
export interface GraphChange {readonly kind:'put'|'delete';readonly id:string}
export interface IndexedStats extends Stats {readonly generation:number}
export class GraphIndex {
 readonly #reader:(id:string)=>readonly string[];#out=new Map<string,Set<string>>();#incoming=new Map<string,Set<string>>();#generation=0;
 constructor(ids:readonly string[],reader:(id:string)=>readonly string[]){this.#reader=reader;if(new Set(ids).size!==ids.length)throw new RangeError('duplicate vertex');this.apply(ids.map(id=>({kind:'put',id})));this.#generation=0;}
 apply(changes:readonly GraphChange[]):number {
  const batch=changes.map(change=>({...change}));if(batch.length===0)return this.#generation;
  this.#generation++;const unique=new Set<string>();
  for(const change of batch){if(unique.has(change.id)||!['put','delete'].includes(change.kind))throw new RangeError('invalid batch');unique.add(change.id);if(change.kind==='delete'&&!this.#out.has(change.id))throw new RangeError('unknown vertex');}
  const loaded=new Map<string,Set<string>>();for(const change of batch)if(change.kind==='put'){const values=this.#reader(change.id);if(!Array.isArray(values)||values.some(value=>typeof value!=='string'))throw new TypeError('invalid dependencies');loaded.set(change.id,new Set(values));}
  const nextOut=new Map(this.#out);const nextIncoming=new Map(this.#incoming);
  const edge=(target:string,source:string,add:boolean)=>{const bucket=new Set(nextIncoming.get(target));if(add)bucket.add(source);else bucket.delete(source);if(bucket.size)nextIncoming.set(target,bucket);else nextIncoming.delete(target);};
  for(const change of batch){nextOut.delete(change.id);if(change.kind==='delete')nextIncoming.delete(change.id);}
  for(const [id,deps] of loaded){nextOut.set(id,deps);for(const target of deps)edge(target,id,true);}
  this.#out=nextOut;this.#incoming=nextIncoming;
  return this.#generation;
 }
 snapshot():IndexedStats {
  const degree=new Map<string,number>();let edges=0;for(const id of this.#out.keys()){const count=this.#incoming.get(id)?.size??0;degree.set(id,count);edges+=count;}
  return {generation:this.#generation,nodes:this.#out.size,edges,inDegree:degree,roots:Object.freeze([...degree].filter(([,count])=>count===0).map(([id])=>id).sort()),missing:Object.freeze([...this.#incoming.keys()].filter(id=>!this.#out.has(id)).sort())};
 }
}
