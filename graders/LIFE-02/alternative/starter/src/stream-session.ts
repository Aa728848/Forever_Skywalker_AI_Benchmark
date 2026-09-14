import {StreamCollector,type StreamEvent,type StreamSummary} from './stream.ts';
export interface StreamSource {subscribe(push:(event:StreamEvent)=>void):()=>void}
export interface Deadline {after(milliseconds:number,run:()=>void):()=>void}

export class StreamSession {
  #collector:StreamCollector;#done=false;#owned:Array<()=>void>=[];
  constructor(source:StreamSource,deadline:Deadline,timeoutMs=5000){
    this.#collector=new StreamCollector({timeoutMs});
    const own=(cleanup:()=>void)=>{if(this.#done)cleanup();else this.#owned.push(cleanup);};
    own(deadline.after(timeoutMs,()=>{if(!this.#done){this.#collector.timeout();this.#close();}}));
    if(this.#done)return;
    try{own(source.subscribe(event=>{if(this.#done)return;this.#collector.push(event);if(event.kind!=='data')this.#close();}));}catch(error){this.#close();throw error;}
  }
  get summary():StreamSummary{return this.#collector.summary;}
  #close():void{if(this.#done)return;this.#done=true;for(const release of this.#owned.splice(0))release();}
  cancel():void{if(!this.#done){this.#collector.push({kind:'error',message:'已取消'});this.#close();}}
}
