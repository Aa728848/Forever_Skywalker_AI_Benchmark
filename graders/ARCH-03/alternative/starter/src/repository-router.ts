import {AdapterError,type ReadResult,type V2Result} from './repository.ts';
export interface CancellableAdapter {load(id:string,signal:AbortSignal):Promise<V2Result>}
export class ReadCancelledError extends Error {constructor(){super('读取已取消');}}
export class AdapterReplacedError extends Error {constructor(){super('读取所属适配器已替换');}}

interface Subscription {resolve(value:ReadResult):void;reject(error:unknown):void;remove():void}
interface Operation {id:string;controller:AbortController;subscribers:Subscription[]}
export class RepositoryRouter {
  #adapter:CancellableAdapter;#pending:Operation[]=[];
  constructor(adapter:CancellableAdapter){this.#adapter=adapter;}
  replace(adapter:CancellableAdapter):void{this.#adapter=adapter;const old=this.#pending;this.#pending=[];for(const operation of old){const subscribers=operation.subscribers.splice(0);for(const subscriber of subscribers){subscriber.remove();subscriber.reject(new AdapterReplacedError());}operation.controller.abort();}}
  #complete(operation:Operation,value?:V2Result,cause?:unknown):void{this.#pending=this.#pending.filter(item=>item!==operation);for(const subscriber of operation.subscribers.splice(0)){subscriber.remove();if(value)subscriber.resolve({ok:value.status==='ok',durationMs:1000*value.durationSeconds,body:value.status==='missing'?null:value.body});else subscriber.reject(new AdapterError(operation.id,cause));}}
  read(id:string,signal?:AbortSignal):Promise<ReadResult>{
    if(signal?.aborted)return Promise.reject(new ReadCancelledError());
    let operation=this.#pending.find(item=>item.id===id);const fresh=!operation;if(!operation){operation={id,controller:new AbortController(),subscribers:[]};this.#pending.push(operation);}const current=operation;
    const promise=new Promise<ReadResult>((resolve,reject)=>{const subscription:Subscription={resolve,reject,remove:()=>signal?.removeEventListener('abort',abort)};
      const abort=()=>{current.subscribers=current.subscribers.filter(item=>item!==subscription);subscription.remove();reject(new ReadCancelledError());if(!current.subscribers.length){this.#pending=this.#pending.filter(item=>item!==current);current.controller.abort();}};
      current.subscribers.push(subscription);signal?.addEventListener('abort',abort,{once:true});});
    if(fresh){try{const response=this.#adapter.load(id,current.controller.signal);Promise.resolve(response).then(value=>this.#complete(current,value),error=>this.#complete(current,undefined,error));}catch(error){this.#complete(current,undefined,error);}}
    return promise;
  }
}
