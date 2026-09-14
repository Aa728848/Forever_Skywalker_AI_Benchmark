export type Cleanup = () => void | Promise<void>;
export interface SetupContext { readonly signal: AbortSignal; defer(cleanup: Cleanup): void }
export interface AsyncPlugin { readonly id: string; setup(context: SetupContext): void | Promise<void> }
export interface Activation { readonly id: string; readonly status: 'active' | 'superseded' }
export class ScopeClosedError extends Error { constructor(){super('资源作用域已封闭');this.name='ScopeClosedError';} }
export class PluginSetupError extends Error {
  readonly id:string; readonly errors:readonly unknown[];
  constructor(id:string,errors:readonly unknown[]){super('插件启动失败：'+id);this.name='PluginSetupError';this.id=id;this.errors=[...errors];}
}

export class AsyncPluginHost {
  #active:string|null=null;
  #cleanup:Cleanup[]=[];
  #closed=false;
  get active():string|null{return this.#active;}
  async replace(plugin:AsyncPlugin):Promise<Activation>{
    if(this.#closed)throw new ScopeClosedError();if(!plugin.id.trim())throw new RangeError('plugin id');
    if(this.#active===plugin.id)return {id:plugin.id,status:'active'};
    for(const cleanup of this.#cleanup)await cleanup();this.#cleanup=[];
    const controller=new AbortController();
    await plugin.setup({signal:controller.signal,defer:cleanup=>this.#cleanup.push(cleanup)});
    this.#active=plugin.id;return {id:plugin.id,status:'active'};
  }
  async dispose():Promise<void>{if(this.#closed)return;this.#closed=true;for(const cleanup of this.#cleanup)await cleanup();this.#cleanup=[];this.#active=null;}
}
