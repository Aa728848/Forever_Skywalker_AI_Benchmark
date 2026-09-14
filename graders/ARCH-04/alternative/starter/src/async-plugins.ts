export type Cleanup = () => void | Promise<void>;
export interface SetupContext { readonly signal: AbortSignal; defer(cleanup: Cleanup): void }
export interface AsyncPlugin { readonly id: string; setup(context: SetupContext): void | Promise<void> }
export interface Activation { readonly id: string; readonly status: 'active' | 'superseded' }
export class ScopeClosedError extends Error { constructor(){super('资源作用域已封闭');this.name='ScopeClosedError';} }
export class PluginSetupError extends Error {
  readonly id:string; readonly errors:readonly unknown[];
  constructor(id:string,errors:readonly unknown[]){super('插件启动失败：'+id);this.name='PluginSetupError';this.id=id;this.errors=[...errors];}
}

interface Entry {id:string;controller:AbortController;cleanups:Cleanup[];ready:Promise<void>;settle:ReturnType<typeof Promise.withResolvers<void>>;open:boolean;closing?:Promise<void>}
export class AsyncPluginHost {
  #selected:Entry|undefined;
  #owned:Entry[]=[];
  #ticket:object={};
  #stopped=false;
  #shutdown:Promise<void>|undefined;
  get active():string|null{return this.#selected?.id??null;}
  #close(entry:Entry):Promise<void>{
    if(entry.closing)return entry.closing;
    const deferred=Promise.withResolvers<void>();entry.closing=deferred.promise;entry.controller.abort();
    void entry.ready.then(()=>undefined,()=>undefined).then(async()=>{
      const pending=entry.cleanups.splice(0).reverse();const errors:unknown[]=[];
      for(const cleanup of pending){try{await cleanup();}catch(error){errors.push(error);}}
      this.#owned=this.#owned.filter(other=>other!==entry);
      if(errors.length)throw new AggregateError(errors,'资源清理失败');
    }).then(deferred.resolve,deferred.reject);return deferred.promise;
  }
  replace(plugin:AsyncPlugin):Promise<Activation>{
    if(this.#stopped)return Promise.reject(new ScopeClosedError());
    if(!plugin.id.trim())return Promise.reject(new RangeError('plugin id'));
    const ticket={};this.#ticket=ticket;
    this.#owned.filter(entry=>entry!==this.#selected).forEach(entry=>entry.controller.abort());
    if(this.#selected?.id===plugin.id)return Promise.resolve({id:plugin.id,status:'active'});
    const settle=Promise.withResolvers<void>();const entry:Entry={id:plugin.id,controller:new AbortController(),cleanups:[],ready:settle.promise,settle,open:true};
    this.#owned.push(entry);
    const result=entry.ready.then(async():Promise<Activation>=>{
      if(this.#stopped||this.#ticket!==ticket){await this.#close(entry);return {id:entry.id,status:'superseded'};}
      const old=this.#selected;this.#selected=entry;if(old)await this.#close(old);return {id:entry.id,status:'active'};
    },async(error):Promise<Activation>=>{
      const errors=[error];try{await this.#close(entry);}catch(cleanup){errors.push(cleanup);}
      if(errors.length>1||(!this.#stopped&&this.#ticket===ticket))throw new PluginSetupError(entry.id,errors);
      return {id:entry.id,status:'superseded'};
    });
    try{const setup=plugin.setup({signal:entry.controller.signal,defer:cleanup=>{if(!entry.open)throw new ScopeClosedError();entry.cleanups.push(cleanup);}});
      Promise.resolve(setup).then(()=>{entry.open=false;settle.resolve();},error=>{entry.open=false;settle.reject(error);});
    }catch(error){entry.open=false;settle.reject(error);}
    return result;
  }
  dispose():Promise<void>{
    if(this.#shutdown)return this.#shutdown;
    this.#stopped=true;this.#ticket={};this.#selected=undefined;
    const done=Promise.withResolvers<void>();this.#shutdown=done.promise;
    void Promise.allSettled(this.#owned.map(entry=>this.#close(entry))).then(results=>{
      const errors=results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);
      if(errors.length)done.reject(new AggregateError(errors,'宿主清理失败'));else done.resolve();
    });return done.promise;
  }
}
