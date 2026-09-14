import {migrate,type Snapshot} from './snapshot.ts';
export interface SnapshotInput {readonly key:string;readonly value:unknown}
export interface SnapshotItem {readonly key:string;readonly value:Snapshot}
export class SnapshotBatchError extends Error {readonly index:number;readonly key:string;override readonly cause:unknown;constructor(index:number,key:string,cause:unknown){super('批次快照无效');this.index=index;this.key=key;this.cause=cause;}}

export class SnapshotBatch {
  #items:SnapshotItem[]=[];
  get items():readonly SnapshotItem[]{return this.#items;}
  replace(input:readonly SnapshotInput[]):readonly SnapshotItem[]{this.#items=[];for(const item of input)this.#items.push({key:item.key,value:migrate(item.value)});return this.items;}
}
