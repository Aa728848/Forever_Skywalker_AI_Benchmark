import {open,readFile,rename,unlink} from 'node:fs/promises';
import type {Storage} from './persistent-cache.ts';
export type FileCheckpoint='temporary-written'|'before-rename';
export class AtomicFileStorage implements Storage {
 readonly #path:string;readonly #checkpoint:((point:FileCheckpoint)=>void)|undefined;#tail=Promise.resolve();
 constructor(path:string,onCheckpoint?:(point:FileCheckpoint)=>void){this.#path=path;this.#checkpoint=onCheckpoint;}
 async read():Promise<string|null>{await this.#tail;try{return await readFile(this.#path,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}
 writeAtomic(text:string):Promise<void>{const pending=this.#tail.then(async()=>{
  const temporary=this.#path+'.replacement';
  try{
   const handle=await open(temporary,'w');
   try{await handle.writeFile(text,'utf8');this.#checkpoint?.('temporary-written');await handle.sync();}finally{await handle.close();}
   this.#checkpoint?.('before-rename');
   await rename(temporary,this.#path);
  }finally{try{await unlink(temporary);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
 });this.#tail=pending.then(()=>{},()=>{});return pending;}
}
