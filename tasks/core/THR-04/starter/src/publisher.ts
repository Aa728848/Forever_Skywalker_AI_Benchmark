import {Worker} from 'node:worker_threads';
export interface Job { readonly id:string; readonly value:number; readonly gate?:SharedArrayBuffer; readonly crash?:boolean }
export interface Snapshot { readonly generation:number|null; readonly values:ReadonlyMap<string,number> }

export class Publisher {
  constructor(maxWorkers=4){void maxWorkers;}
  close():Promise<void>{return Promise.resolve();}
  #latest=-1; #generation:number|null=null; #values=new Map<string,number>();
  snapshot():Snapshot{return {generation:this.#generation,values:new Map(this.#values)};}
  async build(generation:number,jobs:readonly Job[],signal?:AbortSignal):Promise<boolean>{
    if(!Number.isSafeInteger(generation)||generation<=this.#latest)throw new RangeError('generation must increase');
    if(new Set(jobs.map(job=>job.id)).size!==jobs.length)throw new RangeError('duplicate job');
    if(signal?.aborted)return false;
    this.#latest=generation;
    const workers:Worker[]=[];const stop=()=>{for(const worker of workers)void worker.terminate();};
    signal?.addEventListener('abort',stop,{once:true});
    try{
      const values=await Promise.all(jobs.map(job=>new Promise<readonly [string,number]>((resolve,reject)=>{
        const worker=new Worker(new URL('./worker.ts',import.meta.url),{workerData:job});workers.push(worker);let result:number|undefined;let error:Error|undefined;
        worker.once('message',(value:number)=>{result=value;});worker.once('error',(failure:Error)=>{error=failure;});
        worker.once('exit',code=>{if(code===0&&result!==undefined)resolve([job.id,result]);else reject(error??new Error('worker interrupted'));});
      })));
      if(signal?.aborted)return false;
      this.#values=new Map(values);this.#generation=generation;return true;
    }catch(error){await Promise.all(workers.map(worker=>worker.terminate()));if(signal?.aborted)return false;throw error;}
    finally{signal?.removeEventListener('abort',stop);}
  }
}
