import type {Provider} from './providers.ts';
export interface LoadableProvider extends Provider {load():Promise<unknown>}

export class ProviderRegistry {
  #catalog:readonly LoadableProvider[];
  constructor(catalog:readonly LoadableProvider[]){this.#catalog=catalog;}
  list(_runtime:'browser'|'node'):readonly Provider[]{return this.#catalog;}
  load(id:string,_runtime:'browser'|'node'):Promise<unknown>{return this.#catalog.find(item=>item.id===id)!.load();}
}
