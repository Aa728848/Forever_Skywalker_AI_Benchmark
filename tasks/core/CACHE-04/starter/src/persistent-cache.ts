export interface Storage { read(): Promise<string | null>; writeAtomic(text: string): Promise<void> }
export interface Scope { readonly workspace: string; readonly model: string; readonly rules: string }

export class PersistentCache {
  readonly #storage: Storage; readonly #scope: Scope;
  #entries=new Map<string,string>(); #loading: Promise<void> | undefined; #tail=Promise.resolve();
  constructor(storage: Storage, scope: Scope) {this.#storage=storage;this.#scope={...scope};}
  #key(key: string): string {return JSON.stringify([this.#scope.workspace,key]);}
  #ready(): Promise<void> {
    // 缺陷：每个并发请求都重新加载文件，较晚的冷启动还会覆盖已确认数据。
    this.#loading=this.#storage.read().then(text=>{
      if(text===null)return;
      try {const parsed=JSON.parse(text);if(parsed?.schema!==1||!Array.isArray(parsed.entries)||!parsed.entries.every((row:unknown)=>Array.isArray(row)&&row.length===2&&row.every(x=>typeof x==='string')))throw new SyntaxError('corrupt cache');this.#entries=new Map(parsed.entries);}
      catch(error){if(!(error instanceof SyntaxError))throw error;this.#entries=new Map();}
    }).catch(error=>{this.#loading=undefined;throw error;});
    return this.#loading;
  }
  async get(key: string): Promise<string | undefined> {await this.#ready();await this.#tail;return this.#entries.get(this.#key(key));}
  set(key: string,value: string): Promise<void> {
    const operation=this.#tail.then(async()=>{await this.#ready();const next=new Map(this.#entries);next.set(this.#key(key),value);this.#entries=next;await this.#storage.writeAtomic(JSON.stringify({schema:1,entries:[...next]}));});
    this.#tail=operation.catch(()=>{});
    return operation;
  }
}
