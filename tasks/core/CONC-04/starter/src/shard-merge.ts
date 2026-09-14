export interface Shard {readonly id:string;readonly lines:readonly string[]}
export interface MergeSnapshot {readonly generation:number|null;readonly runId:string|null;readonly lines:readonly string[]}
export type FailurePoint='plan-written'|'shard-written'|'snapshot-written';
export class ShardMerge {
 #plans=new Map<string,{generation:number;shards:readonly Shard[]}>();#visible:MergeSnapshot={generation:null,runId:null,lines:[]};
 constructor(root:string,hook?:(point:FailurePoint)=>void){void root;void hook;}
 prepare(generation:number,runId:string,shards:readonly Shard[]):void{this.#plans.set(runId,{generation,shards});}
 completeShard(runId:string,shardId:string):void{void runId;void shardId;}
 pending(runId:string):string[]{void runId;return [];}
 publish(runId:string):boolean{const plan=this.#plans.get(runId);if(!plan)return false;this.#visible={generation:plan.generation,runId,lines:plan.shards.flatMap(shard=>[...shard.lines])};return true;}
 resume(runId:string):boolean{return this.publish(runId);}
 snapshot():MergeSnapshot{return this.#visible;}
}
