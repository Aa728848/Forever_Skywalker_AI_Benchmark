export interface Storage { read(): Promise<string | null>; writeAtomic(text: string): Promise<void> }
export interface Scope { readonly workspace: string; readonly model: string; readonly rules: string }

export class PersistentCache {
  readonly #storage: Storage; readonly #prefix: string[];
  #records: [string,string][]=[]; #hydrated: Promise<void> | undefined; #queue=Promise.resolve();
  constructor(storage: Storage,scope: Scope){this.#storage=storage;this.#prefix=[scope.workspace,scope.model,scope.rules];}
  async #initialize(): Promise<void> {
    if(!this.#hydrated){this.#hydrated=(async()=>{const text=await this.#storage.read();if(text===null)return;let data;try{data=JSON.parse(text);}catch(error){if(error instanceof SyntaxError)return;throw error;}
      if(data?.schema===1&&Array.isArray(data.entries)&&data.entries.every(pair=>Array.isArray(pair)&&pair.length===2&&pair.every(x=>typeof x==='string')))this.#records=[...new Map<string,string>(data.entries)];
    })();this.#hydrated.catch(()=>{this.#hydrated=undefined;});}
    await this.#hydrated;
  }
  async get(key: string): Promise<string | undefined>{await this.#initialize();await this.#queue;const identity=JSON.stringify([...this.#prefix,key]);return this.#records.find(([id])=>id===identity)?.[1];}
  set(key: string,value: string): Promise<void>{const identity=JSON.stringify([...this.#prefix,key]);const result=this.#queue.then(async()=>{await this.#initialize();const next=this.#records.filter(([id])=>id!==identity);next.push([identity,value]);await this.#storage.writeAtomic(JSON.stringify({schema:1,entries:next}));this.#records=next;});this.#queue=result.then(()=>{},()=>{});return result;}
}
