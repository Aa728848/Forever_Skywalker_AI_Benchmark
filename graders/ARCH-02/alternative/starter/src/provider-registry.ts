import {resolveProviders,type Provider} from './providers.ts';
export interface LoadableProvider extends Provider {load():Promise<unknown>}

export class ProviderRegistry {
  #providers:readonly LoadableProvider[];#entries:Array<{id:string;value:Promise<unknown>}>=[];
  constructor(catalog:readonly LoadableProvider[]){resolveProviders(catalog,'browser');this.#providers=catalog.slice();}
  list(runtime:'browser'|'node'):readonly Provider[]{return this.#providers.filter(item=>item.runtime==='shared'||item.runtime===runtime).map(item=>({id:item.id,label:item.label,runtime:item.runtime}));}
  load(id:string,runtime:'browser'|'node'):Promise<unknown>{
    const selected=this.#providers.find(item=>item.id===id&&(item.runtime==='shared'||item.runtime===runtime));if(!selected)return Promise.reject(new RangeError('provider unavailable'));
    const existing=this.#entries.find(entry=>entry.id===id);if(existing)return existing.value;
    const entry={id,value:Promise.resolve().then(()=>selected.load())};this.#entries.push(entry);
    void entry.value.then(()=>{},()=>{this.#entries=this.#entries.filter(item=>item!==entry);});return entry.value;
  }
}
