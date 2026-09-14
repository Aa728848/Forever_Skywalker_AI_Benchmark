import type { Journal } from './ledger.ts';
export interface Receipt { readonly id:string; readonly balance:number; readonly checkpoint:number }
export class TransactionConflictError extends Error { constructor(){super('事务键内容冲突');} }
export class JournalCorruptError extends Error { constructor(){super('日志结构或已确认前缀损坏');} }
interface Record {version:1;id:string;amounts:number[]}

export class TransactionalLedger {
  #journal:Journal;#lines:string[]=[];#receipts:Receipt[]=[];#records:Record[]=[];
  constructor(journal:Journal){this.#journal=journal;this.recover();}
  get balance():number{return this.#receipts.at(-1)?.balance??0;}
  get checkpoint():number{return this.#lines.length;}
  #valid(id:string,amounts:readonly number[]):void{if(typeof id!=='string'||!id.trim()||!Array.isArray(amounts)||amounts.some(n=>!Number.isSafeInteger(n)))throw new RangeError('transaction');}
  recover():number{
    const lines=Array.from(this.#journal.read());if(this.#lines.some((line,index)=>lines[index]!==line))throw new JournalCorruptError();
    const records:Record[]=[];const receipts:Receipt[]=[];const seen=new Set<string>();let total=0;
    try{for(const line of lines){const record=JSON.parse(line) as Record;this.#valid(record.id,record.amounts);if(record.version!==1||seen.has(record.id))throw new JournalCorruptError();seen.add(record.id);
      for(const n of record.amounts){total+=n;if(!Number.isSafeInteger(total))throw new JournalCorruptError();}records.push(record);receipts.push({id:record.id,balance:total,checkpoint:receipts.length+1});}}
    catch{throw new JournalCorruptError();}
    this.#lines=lines;this.#records=records;this.#receipts=receipts;return total;
  }
  commit(id:string,amounts:readonly number[]):Receipt{
    this.#valid(id,amounts);this.recover();const index=this.#records.findIndex(record=>record.id===id);
    if(index>=0){const old=this.#records[index]!.amounts;if(old.length!==amounts.length||old.some((n,i)=>n!==amounts[i]))throw new TransactionConflictError();return {...this.#receipts[index]!};}
    let total=this.balance;for(const n of amounts){total+=n;if(!Number.isSafeInteger(total))throw new RangeError('balance');}
    let failed=false,cause:unknown;try{this.#journal.append(JSON.stringify({version:1,id,amounts:[...amounts]}));}catch(error){failed=true;cause=error;}
    this.recover();const receipt=this.#receipts.find(item=>item.id===id);if(!receipt){if(failed)throw cause;throw new JournalCorruptError();}return {...receipt};
  }
}
