import type { Journal } from './ledger.ts';
export interface Receipt { readonly id:string; readonly balance:number; readonly checkpoint:number }
export class TransactionConflictError extends Error { constructor(){super('事务键内容冲突');} }
export class JournalCorruptError extends Error { constructor(){super('日志结构或已确认前缀损坏');} }
interface Record {version:1;id:string;amounts:number[]}

export class TransactionalLedger {
  #journal:Journal;#balance=0;#checkpoint=0;
  constructor(journal:Journal){this.#journal=journal;this.recover();}
  get balance():number{return this.#balance;}
  get checkpoint():number{return this.#checkpoint;}
  recover():number{for(const line of this.#journal.read()){const row=JSON.parse(line) as Record;for(const amount of row.amounts)this.#balance+=amount;this.#checkpoint++;}return this.#balance;}
  commit(id:string,amounts:readonly number[]):Receipt{this.#journal.append(JSON.stringify({version:1,id,amounts}));for(const amount of amounts)this.#balance+=amount;this.#checkpoint++;return {id,balance:this.#balance,checkpoint:this.#checkpoint};}
}
