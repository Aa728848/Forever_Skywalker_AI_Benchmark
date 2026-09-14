export class GroupCancelledError extends Error {readonly pending:readonly string[];constructor(pending:readonly string[]){super('group cancelled');this.pending=pending;}}
interface Member {controller:AbortController;reject(error:unknown):void;done:Promise<void>}
export class TaskGroup {
 #members:{id:string;member:Member}[]=[];
 get active():readonly string[]{return this.#members.map(entry=>entry.id);}
 run<T>(id:string,work:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  if(this.#members.some(entry=>entry.id===id))return Promise.reject(new Error('duplicate active id'));
  let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const result=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  let markDone!:()=>void;const member:Member={controller:new AbortController(),reject,done:new Promise<void>(resolve=>{markDone=resolve;})};this.#members.push({id,member});
  let started:Promise<T>;try{started=Promise.resolve(work(member.controller.signal));}catch(error){started=Promise.reject(error);}
  void started.then(value=>{this.#members=this.#members.filter(entry=>entry.member!==member);resolve(value);},error=>{this.#members=this.#members.filter(entry=>entry.member!==member);reject(error);}).then(markDone,markDone);
  return result;
 }
 async cancelAll():Promise<void>{const entries=this.#members.map(entry=>[entry.id,entry.member] as const);const error=new GroupCancelledError(entries.map(([id])=>id));for(const [id,member] of entries)this.#members=this.#members.filter(entry=>entry.member!==member);for(const [,member] of entries){member.controller.abort();member.reject(error);}await Promise.all(entries.map(([,member])=>member.done));}
}
