import {Worker} from 'node:worker_threads';
export interface Job {readonly id:string;readonly value:number;readonly gate?:SharedArrayBuffer;readonly crash?:boolean}
export interface Snapshot {readonly generation:number|null;readonly values:ReadonlyMap<string,number>}
interface Run {generation:number;jobs:Job[];stopped:boolean;workers:Set<Worker>;promise:Promise<boolean>;stop():void}
export class Publisher {
 private latest=-1;private visible:Snapshot={generation:null,values:new Map()};private runs=new Set<Run>();private tail:Promise<unknown>=Promise.resolve();private closed=false;private closing:Promise<void>|undefined;private size:number;
 constructor(maxWorkers=4){if(!Number.isInteger(maxWorkers)||maxWorkers<1||maxWorkers>8)throw new RangeError('maxWorkers 1..8');this.size=maxWorkers;}
 snapshot():Snapshot{return {generation:this.visible.generation,values:new Map(this.visible.values)};}
 build(generation:number,jobs:readonly Job[],signal?:AbortSignal):Promise<boolean>{
  if(this.closed)return Promise.reject(new Error('publisher closed'));
  if(!Number.isSafeInteger(generation)||generation<0||generation<=this.latest)return Promise.reject(new RangeError('generation'));
  if(new Set(jobs.map(job=>job.id)).size!==jobs.length)return Promise.reject(new RangeError('duplicate job'));
  if(signal?.aborted)return Promise.resolve(false);this.latest=generation;for(const old of this.runs)old.stop();
  const run:Run={generation,jobs:jobs.map(job=>({...job})),stopped:false,workers:new Set(),promise:Promise.resolve(false),stop(){this.stopped=true;for(const worker of this.workers)void worker.terminate();}};
  const abort=()=>run.stop();signal?.addEventListener('abort',abort,{once:true});this.runs.add(run);
  run.promise=this.tail.catch(()=>{}).then(async()=>{
   let next=0;const values=new Map<string,number>();let failure:unknown;
   const lane=async()=>{while(!run.stopped&&next<run.jobs.length){const job=run.jobs[next++]!;try{const value=await new Promise<number>((resolve,reject)=>{const worker=new Worker(new URL('./worker.ts',import.meta.url),{workerData:job});run.workers.add(worker);let result:number|undefined;let error:unknown;worker.once('message',(value:number)=>{result=value;});worker.once('error',value=>{error=value;});worker.once('exit',code=>{run.workers.delete(worker);if(code===0&&result!==undefined)resolve(result);else reject(error??new Error('worker failed'));});});values.set(job.id,value);}catch(error){if(!run.stopped){failure=error;run.stop();}}}};
   await Promise.all(Array.from({length:Math.min(this.size,run.jobs.length)},lane));
   if(failure!==undefined)throw failure;if(run.stopped||generation!==this.latest)return false;this.visible={generation,values};return true;
  }).finally(()=>{signal?.removeEventListener('abort',abort);this.runs.delete(run);});
  this.tail=run.promise;return run.promise;
 }
 close():Promise<void>{if(this.closing)return this.closing;this.closed=true;for(const run of this.runs)run.stop();this.closing=Promise.allSettled([...this.runs].map(run=>run.promise)).then(()=>{});return this.closing;}
}
