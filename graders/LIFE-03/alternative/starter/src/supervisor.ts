export interface Runner {run(signal:AbortSignal):Promise<void>}
export type Phase='idle'|'starting'|'running'|'stopping';
interface Generation {controller:AbortController;finished:Promise<void>}
/** 操作队列只串行化启动/停止控制，不等待运行生命周期结束才允许stop。 */
export class Supervisor {
  #runner:Runner;#phase:Phase='idle';#queue=Promise.resolve();#generation:Generation|undefined;#starts=0;
  constructor(runner:Runner){this.#runner=runner;}
  get phase():Phase{return this.#phase;}get startCount():number{return this.#starts;}
  #enqueue(action:()=>Promise<void>):Promise<void>{const next=this.#queue.then(action,action);this.#queue=next.then(()=>undefined,()=>undefined);return next;}
  start():Promise<void>{return this.#enqueue(async()=>{
    if(this.#generation)return;this.#phase='starting';this.#starts++;
    const gate=Promise.withResolvers<void>();const generation:Generation={controller:new AbortController(),finished:gate.promise};this.#generation=generation;
    const finish=()=>{if(this.#generation===generation&&this.#phase!=='stopping'){this.#generation=undefined;this.#phase='idle';}gate.resolve();};
    try{Promise.resolve(this.#runner.run(generation.controller.signal)).then(finish,finish);}catch(error){finish();throw error;}
    if(this.#generation===generation)this.#phase='running';
  });}
  stop():Promise<void>{return this.#enqueue(async()=>{const generation=this.#generation;if(!generation)return;this.#phase='stopping';generation.controller.abort();await generation.finished;if(this.#generation===generation)this.#generation=undefined;this.#phase='idle';});}
}
