import {Worker} from 'node:worker_threads';
export interface Job { readonly id:string; readonly value:number; readonly gate?:SharedArrayBuffer; readonly crash?:boolean }
export interface Snapshot { readonly generation:number|null; readonly values:ReadonlyMap<string,number> }

export class Publisher {
  #latest=-1; #ticket:object={}; #visible:Snapshot={generation:null,values:new Map()};
  snapshot():Snapshot{return {...this.#visible,values:new Map(this.#visible.values)};}
  async build(generation:number,jobs:readonly Job[],signal?:AbortSignal):Promise<boolean>{
    if(!Number.isSafeInteger(generation)||generation<=this.#latest)throw new RangeError('generation must increase');
    if(new Set(jobs.map(job=>job.id)).size!==jobs.length)throw new RangeError('duplicate job');
    if(signal?.aborted)return false;
    this.#latest=generation;const ticket={};this.#ticket=ticket;const workers:Worker[]=[];
    const stop=()=>{for(const worker of workers)void worker.terminate();};signal?.addEventListener('abort',stop,{once:true});
    const result=await Promise.allSettled(jobs.map(job=>new Promise<[string,number]>((resolve,reject)=>{
      const worker=new Worker(new URL('./worker.ts',import.meta.url),{workerData:job});workers.push(worker);let message:number|undefined;let failure:Error|undefined;
      worker.on('message',(value:number)=>{message=value;});worker.on('error',(error:Error)=>{failure=error;stop();});
      worker.on('exit',code=>{if(code===0&&message!==undefined)resolve([job.id,message]);else{reject(failure??new Error('worker interrupted'));stop();}});
    })));
    signal?.removeEventListener('abort',stop);
    await Promise.all(workers.map(worker=>worker.terminate()));
    if(signal?.aborted)return false;
    const failure=result.find(item=>item.status==='rejected');if(failure?.status==='rejected')throw failure.reason;
    if(this.#ticket!==ticket)return false;
    this.#visible={generation,values:new Map(result.map(item=>(item as PromiseFulfilledResult<[string,number]>).value))};return true;
  }
}
