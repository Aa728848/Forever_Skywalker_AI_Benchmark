import {open,readFile,unlink} from 'node:fs/promises';
import type {Storage,Snapshot} from './persistent-cache.ts';
export type FileCheckpoint='temporary-written'|'before-rename';
export class AtomicFileStorage implements Storage {
 readonly #path:string;readonly #checkpoint:((point:FileCheckpoint)=>void)|undefined;#tail=Promise.resolve();
 constructor(path:string,onCheckpoint?:(point:FileCheckpoint)=>void){this.#path=path;this.#checkpoint=onCheckpoint;}
 async read():Promise<string|null>{return (await this.readVersioned()).text;}
 async readVersioned():Promise<Snapshot>{await this.#tail;try{const text=await readFile(this.#path,'utf8');return {text,epoch:0};}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {text:null,epoch:0};throw error;}}
 // 缺陷：条件写入没有真正比较版本，直接走普通写入。
 async writeAtomicIfUnchanged(text:string,epoch:number):Promise<void>{void epoch;return this.writeAtomic(text);}
 writeAtomic(text:string):Promise<void>{const pending=this.#tail.then(async()=>{
  const temporary=this.#path+'.pending';
  try{
   const handle=await open(this.#path,'w');
   try{await handle.writeFile(text,'utf8');this.#checkpoint?.('temporary-written');await handle.sync();}finally{await handle.close();}
   this.#checkpoint?.('before-rename');
   // Published by the direct write above.
  }finally{try{await unlink(temporary);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
 });this.#tail=pending.then(()=>{},()=>{});return pending;}
}
