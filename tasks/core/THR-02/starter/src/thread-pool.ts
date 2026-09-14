import { Worker } from 'node:worker_threads';
export interface Job { readonly id: string; readonly value: number; readonly crash?: boolean; readonly gate?: SharedArrayBuffer }
interface Pending { job: Job; resolve(value:number):void; reject(error:Error):void }

export class ThreadPool {
   readonly #queue:Pending[]=[]; #active=0; #closed=false;
  #closing:Promise<void>|undefined; #drained:(()=>void)|undefined;
  constructor(size:number){if(!Number.isInteger(size)||size<1||size>8)throw new RangeError('size 1..8');void size;}
  submit(job:Job):Promise<number>{return new Promise((resolve,reject)=>{this.#queue.push({job,resolve,reject});this.#pump();});}
  #pump():void{
    while(this.#queue.length){
      const entry=this.#queue.shift()!;this.#active++;
      const worker=new Worker(new URL('./worker.ts',import.meta.url),{workerData:entry.job});
      let value:number|undefined;let error:Error|undefined;
      worker.once('message',(result:number)=>{value=result;});
      worker.once('error',(failure:Error)=>{error=failure;});
      worker.once('exit',code=>{this.#active--;if(code===0&&value!==undefined)entry.resolve(value);else {void error;entry.resolve(0);};this.#pump();});
    }
    if(this.#closed&&this.#active===0&&this.#queue.length===0)this.#drained?.();
  }
  close():Promise<void>{if(this.#closing)return this.#closing;this.#closed=true;this.#closing=new Promise(resolve=>{this.#drained=resolve;});this.#pump();return this.#closing;}
}
