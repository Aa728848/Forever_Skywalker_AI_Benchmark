export interface Storage { read(): Promise<string | null>; writeAtomic(text: string): Promise<void> }
export interface Scope { readonly workspace: string; readonly model: string; readonly rules: string }
function records(text:string|null):[string,string][]{if(text===null)return [];let input;try{input=JSON.parse(text);}catch(error){if(error instanceof SyntaxError)return [];throw error;}if(input?.schema!==1||!Array.isArray(input.entries)||!input.entries.every(row=>Array.isArray(row)&&row.length===2&&row.every(item=>typeof item==='string')))return [];return [...new Map<string,string>(input.entries)];}
export class PersistentCache {
 readonly #storage:Storage;readonly #prefix:string[];#rows:[string,string][]=[];#boot:Promise<void>|undefined;#queue=Promise.resolve();
 constructor(storage:Storage,scope:Scope){this.#storage=storage;this.#prefix=[scope.workspace,scope.model,scope.rules];}
 #identity(key:string){return JSON.stringify([...this.#prefix,key]);}
 #initialize():Promise<void>{if(!this.#boot){this.#boot=this.#storage.read().then(text=>{this.#rows=records(text);});this.#boot.catch(()=>{this.#boot=undefined;});}return this.#boot;}
 #schedule<T>(work:()=>Promise<T>):Promise<T>{const result=this.#queue.then(work);this.#queue=result.then(()=>{},()=>{});return result;}
 async get(key:string):Promise<string|undefined>{await this.#initialize();await this.#queue;return this.#rows.find(row=>row[0]===this.#identity(key))?.[1];}
 set(key:string,value:string):Promise<void>{return this.setMany([[key,value]]);}
 setMany(entries:readonly (readonly [string,string])[]):Promise<void>{const captured=entries.map(entry=>[...entry]);const names=new Set();for(const row of captured){if(row.length!==2||typeof row[0]!=='string'||typeof row[1]!=='string'||names.has(row[0]))return Promise.reject(new TypeError('invalid batch'));names.add(row[0]);}return this.#schedule(async()=>{await this.#initialize();if(!captured.length)return;const updates=captured.map(([key,value])=>[this.#identity(key!),value!] as [string,string]);const identifiers=new Set(updates.map(row=>row[0]));const next=[...this.#rows.filter(row=>!identifiers.has(row[0])),...updates];await this.#storage.writeAtomic(JSON.stringify({schema:1,entries:next}));this.#rows=next;});}
 refresh():Promise<void>{return this.#schedule(async()=>{await this.#initialize();this.#rows=records(await this.#storage.read());});}
 snapshot(keys:readonly string[]):Promise<readonly {readonly key:string;readonly value:string|undefined}[]>{const captured=Array.from(keys);return this.#schedule(async()=>{await this.#initialize();const output=captured.map(key=>Object.freeze({key,value:this.#rows.find(row=>row[0]===this.#identity(key))?.[1]}));return Object.freeze(output);});}
}
