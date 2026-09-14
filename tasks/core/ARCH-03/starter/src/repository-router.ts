import type {ReadResult,V2Result} from './repository.ts';
export interface CancellableAdapter {load(id:string,signal:AbortSignal):Promise<V2Result>}
export class ReadCancelledError extends Error {constructor(){super('读取已取消');}}
export class AdapterReplacedError extends Error {constructor(){super('读取所属适配器已替换');}}

export class RepositoryRouter {
  #adapter:CancellableAdapter;
  constructor(adapter:CancellableAdapter){this.#adapter=adapter;}
  replace(adapter:CancellableAdapter):void{this.#adapter=adapter;}
  async read(id:string,_signal?:AbortSignal):Promise<ReadResult>{const value=await this.#adapter.load(id,new AbortController().signal);return {ok:value.status==='ok',durationMs:value.durationSeconds,body:value.body};}
}
