export interface ProjectionEvent {readonly seq:number;readonly session:string;readonly epoch:number;readonly kind:'open'|'message'|'close';readonly at:number;readonly payload?:string}
export interface ProjectionRow {readonly id:string;readonly epoch:number;readonly open:boolean;readonly messages:number;readonly bytes:number;readonly lastAt:number}
export interface ProjectionCheckpoint {readonly schema:1;readonly logId:string;readonly through:number;readonly rows:readonly ProjectionRow[]}
export interface ProjectionLimits {readonly maxSessions:number;readonly maxBatchEvents:number;readonly maxBatchBytes:number}
export interface ProjectionTicket {readonly through:number;readonly accepted:number}
export class ProjectionError extends Error {readonly code:string;constructor(code:string){super(code);this.code=code;}}
function checkpoint(logId:string,through:number,rows:Map<string,ProjectionRow>):ProjectionCheckpoint{return Object.freeze({schema:1 as const,logId,through,rows:Object.freeze([...rows.values()].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0))});}
function restore(limits:ProjectionLimits,input:ProjectionCheckpoint|undefined):Map<string,ProjectionRow>{
 if(!input)return new Map();
 if(input.schema!==1||!Number.isSafeInteger(input.through)||input.through<0||!Array.isArray(input.rows)||input.rows.length>limits.maxSessions)throw new ProjectionError('checkpoint');
 const rows=new Map<string,ProjectionRow>();for(const row of input.rows){if(!row||typeof row.id!=='string'||!row.id.length||rows.has(row.id)||!Number.isSafeInteger(row.epoch)||row.epoch<1||typeof row.open!=='boolean'||!Number.isSafeInteger(row.messages)||row.messages<0||!Number.isSafeInteger(row.bytes)||row.bytes<0||!Number.isFinite(row.lastAt))throw new ProjectionError('checkpoint');rows.set(row.id,Object.freeze({...row}));}return rows;
}
interface Prepared {readonly revision:number;readonly rows:Map<string,ProjectionRow>;readonly checkpoint:ProjectionCheckpoint;readonly accepted:number}
export class SessionProjection {
 readonly #logId:string;readonly #limits:ProjectionLimits;#rows:Map<string,ProjectionRow>;#snapshot:ProjectionCheckpoint;#revision=0;#tickets=new WeakMap<ProjectionTicket,Prepared>();#tail=Promise.resolve();
 constructor(logId:string,limits:ProjectionLimits,initial?:ProjectionCheckpoint){if(!logId||!Object.values(limits).every(value=>Number.isSafeInteger(value)&&value>0)||!['maxSessions','maxBatchEvents','maxBatchBytes'].every(key=>key in limits))throw new ProjectionError('invalid');this.#logId=logId;this.#limits={...limits};this.#rows=restore(limits,initial);this.#snapshot=checkpoint(logId,initial?.through??0,this.#rows);}
 snapshot():ProjectionCheckpoint{return this.#snapshot;}
 prepare(events:readonly ProjectionEvent[]):ProjectionTicket{
  if(events.length>this.#limits.maxBatchEvents)throw new ProjectionError('capacity');let bytes=0;
  for(const event of events){if(!event||!Number.isSafeInteger(event.seq)||event.seq<1||typeof event.session!=='string'||!event.session.length||!Number.isSafeInteger(event.epoch)||event.epoch<1||!['open','message','close'].includes(event.kind)||!Number.isFinite(event.at)||event.payload!==undefined&&typeof event.payload!=='string')throw new ProjectionError('invalid');bytes+=Buffer.byteLength(event.payload??'','utf8');}
  if(bytes>this.#limits.maxBatchBytes)throw new ProjectionError('capacity');
  const next=new Map(this.#rows);let through=this.#snapshot.through;let accepted=0;
  for(const event of events){if(event.seq<=through)continue;if(event.seq!==through+1)throw new ProjectionError('gap');const previous=next.get(event.session);let row:ProjectionRow;
   if(event.kind==='open'){if(previous?.open||event.epoch!==(previous?.epoch??0)+1)throw new ProjectionError('lifecycle');if(!previous&&next.size>=this.#limits.maxSessions)throw new ProjectionError('capacity');row={id:event.session,epoch:event.epoch,open:true,messages:0,bytes:Buffer.byteLength(event.payload??'','utf8'),lastAt:event.at};}
   else {if(!previous||!previous.open||previous.epoch!==event.epoch)throw new ProjectionError('lifecycle');row={...previous,open:event.kind!=='close',messages:previous.messages+(event.kind==='message'?1:0),bytes:previous.bytes+Buffer.byteLength(event.payload??'','utf8'),lastAt:Math.max(previous.lastAt,event.at)};}
   next.set(event.session,Object.freeze(row));through=event.seq;accepted++;
  }
  const ticket=Object.freeze({through,accepted});this.#tickets.set(ticket,{revision:this.#revision,rows:next,checkpoint:checkpoint(this.#logId,through,next),accepted});return ticket;
 }
 commit(ticket:ProjectionTicket,persist:(value:ProjectionCheckpoint)=>Promise<void>):Promise<boolean>{const operation=this.#tail.then(async()=>{
  const prepared=this.#tickets.get(ticket);if(!prepared)return false;
  if(prepared.accepted===0){this.#tickets.delete(ticket);return true;}
  this.#rows=prepared.rows;this.#snapshot=prepared.checkpoint;this.#revision++;
  await persist(prepared.checkpoint);this.#tickets.delete(ticket);return true;
 });this.#tail=operation.then(()=>{},()=>{});return operation;}
}
export async function replayProjection(projection:SessionProjection,source:AsyncIterable<readonly ProjectionEvent[]>,persist:(value:ProjectionCheckpoint)=>Promise<void>):Promise<ProjectionCheckpoint>{
 for await(const events of source){const ticket=projection.prepare(events);if(!await projection.commit(ticket,persist))throw new ProjectionError('stale');}
 return projection.snapshot();
}
