import { Worker } from 'node:worker_threads';
export interface Job { readonly id: string; readonly value: number; readonly crash?: boolean; readonly gate?: SharedArrayBuffer }
export class ThreadPool {
  readonly #lanes:Promise<void>[]; #next=0; #closed=false; #closing:Promise<void>|undefined;
  constructor(size:number){if(!Number.isInteger(size)||size<1||size>8)throw new RangeError('size 1..8');this.#lanes=Array.from({length:size},()=>Promise.resolve());}
  submit(job:Job):Promise<number>{
    if(this.#closed)return Promise.reject(new Error('pool closed'));
    const index=this.#next++%this.#lanes.length;
    const result=this.#lanes[index]!.then(()=>new Promise<number>((resolve,reject)=>{
      const worker=new Worker(new URL('./worker.ts',import.meta.url),{workerData:job});let received:number|undefined;let failure:Error|undefined;
      worker.on('message',(value:number)=>{received=value;});worker.on('error',(error:Error)=>{failure=error;});
      worker.once('exit',code=>{if(code!==0||received===undefined)reject(failure??new Error('worker exit '+code));else resolve(received);});
    }));
    this.#lanes[index]=result.then(()=>{},()=>{});return result;
  }
  close():Promise<void>{this.#closed=true;this.#closing??=Promise.all(this.#lanes).then(()=>{});return this.#closing;}
}
