import {open,readFile,rename,unlink} from 'node:fs/promises';
import type {Storage,Snapshot} from './persistent-cache.ts';
import {StaleWriteError} from './persistent-cache.ts';
export type FileCheckpoint='temporary-written'|'before-rename';
/**
 * 与参考实现不同的做法：版本号不计算哈希，而是用主文件的 mtime+size 组合。
 * 同一份内容的两次读取因此得到同一个版本；替换后 mtime 必然变化，落后写入对不上。
 */
export class AtomicFileStorage implements Storage {
 readonly #path:string;readonly #checkpoint:((point:FileCheckpoint)=>void)|undefined;#serial=Promise.resolve();
 constructor(path:string,onCheckpoint?:(point:FileCheckpoint)=>void){this.#path=path;this.#checkpoint=onCheckpoint;}
 async read():Promise<string|null>{return (await this.readVersioned()).text;}
 async readVersioned():Promise<Snapshot>{await this.#serial;return this.#inspect();}
 async #inspect():Promise<Snapshot>{
  try{const text=await readFile(this.#path,'utf8');const {stat}=await import('node:fs/promises');const info=await stat(this.#path);return {text,epoch:info.mtimeMs*1000+info.size};}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {text:null,epoch:0};throw error;}
 }
 writeAtomic(text:string):Promise<void>{return this.#store(text,null);}
 writeAtomicIfUnchanged(text:string,epoch:number):Promise<void>{return this.#store(text,epoch);}
 #store(text:string,expected:number|null):Promise<void>{const pending=this.#serial.then(async()=>{
  if(expected!==null){const current=await this.#inspect();if(current.epoch!==expected)throw new StaleWriteError(expected);}
  const temporary=this.#path+'.staging';
  try{
   const handle=await open(temporary,'w');
   try{await handle.writeFile(text,'utf8');this.#checkpoint?.('temporary-written');await handle.sync();}finally{await handle.close();}
   this.#checkpoint?.('before-rename');
   await rename(temporary,this.#path);
  }finally{try{await unlink(temporary);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
 });this.#serial=pending.then(()=>{},()=>{});return pending;}
}
