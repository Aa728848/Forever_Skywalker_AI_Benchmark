import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,unlinkSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
export interface Shard {readonly id:string;readonly lines:readonly string[]}
export interface MergeSnapshot {readonly generation:number|null;readonly runId:string|null;readonly lines:readonly string[]}
export type FailurePoint='plan-written'|'shard-written'|'snapshot-written';
interface Plan {generation:number;runId:string;order:string[];inputs:Record<string,string[]>}
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const json=<T>(path:string)=>JSON.parse(readFileSync(path,'utf8')) as T;
function replace(path:string,value:unknown){mkdirSync(dirname(path),{recursive:true});const next=path+'.'+randomUUID()+'.tmp';try{writeFileSync(next,JSON.stringify(value),{flag:'wx'});renameSync(next,path);}finally{if(existsSync(next))unlinkSync(next);}}
export class ShardMerge {
 private root:string;private hook:((point:FailurePoint)=>void)|undefined;
 constructor(root:string,hook?:(point:FailurePoint)=>void){this.root=resolve(root);this.hook=hook;mkdirSync(this.root,{recursive:true});}
 private planPath(runId:string){return join(this.root,'runs',digest(runId),'plan.json');}
 private shardPath(runId:string,id:string){return join(this.root,'runs',digest(runId),'shards',digest(id)+'.json');}
 private plan(runId:string){const plan=json<Plan>(this.planPath(runId));if(plan.runId!==runId)throw Error('corrupt plan');return plan;}
 prepare(generation:number,runId:string,shards:readonly Shard[]):void{
  if(!Number.isSafeInteger(generation)||generation<0||!runId||shards.some(shard=>!shard.id)||new Set(shards.map(shard=>shard.id)).size!==shards.length)throw new RangeError('invalid plan');
  const incoming:Plan={generation,runId,order:shards.map(shard=>shard.id),inputs:Object.fromEntries(shards.map(shard=>[shard.id,[...shard.lines]]))};
  const file=this.planPath(runId),present=existsSync(file),headFile=join(this.root,'head.json');
  if(present&&JSON.stringify(json<Plan>(file))!==JSON.stringify(incoming))throw Error('content conflict');
  if(existsSync(headFile)){const head=json<{generation:number;runId:string}>(headFile);if(head.generation>=generation){if(present||head.runId===runId)return;throw new RangeError('generation must increase');}}
  if(!present){replace(file,incoming);this.hook?.('plan-written');}replace(headFile,{generation,runId});
 }
 completeShard(runId:string,shardId:string):void{
  const plan=this.plan(runId);if(!Object.hasOwn(plan.inputs,shardId))throw new RangeError('unknown shard');
  const file=this.shardPath(runId,shardId),expected=plan.inputs[shardId]!;
  if(existsSync(file)){if(digest(JSON.stringify(json<unknown>(file)))!==digest(JSON.stringify(expected)))throw Error('corrupt shard');return;}
  replace(file,expected);this.hook?.('shard-written');
 }
 pending(runId:string):string[]{const plan=this.plan(runId),missing:string[]=[];for(const id of plan.order)if(!existsSync(this.shardPath(runId,id)))missing.push(id);return missing;}
 publish(runId:string):boolean{
  const plan=this.plan(runId),head=join(this.root,'head.json');if(!existsSync(head)||json<{runId:string}>(head).runId!==runId)return false;
  const lines:string[]=[];for(const id of plan.order){const file=this.shardPath(runId,id);if(!existsSync(file))return false;const actual=json<string[]>(file);if(digest(JSON.stringify(actual))!==digest(JSON.stringify(plan.inputs[id])))throw Error('corrupt shard');for(const line of actual)lines.push(line);}
  replace(join(this.root,'visible.json'),{generation:plan.generation,runId,lines});this.hook?.('snapshot-written');return true;
 }
 resume(runId:string):boolean{for(const id of this.pending(runId))this.completeShard(runId,id);return this.publish(runId);}
 snapshot():MergeSnapshot{const file=join(this.root,'visible.json');return existsSync(file)?json<MergeSnapshot>(file):{generation:null,runId:null,lines:[]};}
}
