import {migrate,type Snapshot} from './snapshot.ts';
export interface SnapshotInput {readonly key:string;readonly value:unknown}
export interface SnapshotItem {readonly key:string;readonly value:Snapshot}
export class SnapshotBatchError extends Error {readonly index:number;readonly key:string;override readonly cause:unknown;constructor(index:number,key:string,cause:unknown){super('批次快照无效');this.index=index;this.key=key;this.cause=cause;}}

export class SnapshotBatch {
  #current=new Map<string,Snapshot>();
  get items():readonly SnapshotItem[]{return Array.from(this.#current,([key,value])=>({key,value:{...value}}));}
  replace(input:readonly SnapshotInput[]):readonly SnapshotItem[]{
    const staged=new Map<string,Snapshot>();input.forEach((item,index)=>{try{if(typeof item.key!=='string'||!item.key.trim()||staged.has(item.key))throw new RangeError('key');staged.set(item.key,migrate(item.value));}catch(cause){throw new SnapshotBatchError(index,item.key,cause);}});
    this.#current=staged;return this.items;
  }
}
