import {StreamCollector,type StreamEvent,type StreamSummary} from './stream.ts';
export interface StreamSource {subscribe(push:(event:StreamEvent)=>void):()=>void}
export interface Deadline {after(milliseconds:number,run:()=>void):()=>void}

export class StreamSession {
  #collector:StreamCollector;#release:()=>void;
  constructor(source:StreamSource,deadline:Deadline,timeoutMs=5000){this.#collector=new StreamCollector({timeoutMs});deadline.after(timeoutMs,()=>this.#collector.timeout());this.#release=source.subscribe(event=>this.#collector.push(event));}
  get summary():StreamSummary{return this.#collector.summary;}
  cancel():void{this.#release();this.#collector.push({kind:'error',message:'已取消'});}
}
