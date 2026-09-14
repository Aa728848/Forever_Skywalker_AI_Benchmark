import assert from 'node:assert/strict';import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';
const workspace=process.argv[2];if(!workspace)throw new Error('需要候选工作区路径');const {SessionProjection,replayProjection}=await import(pathToFileURL(resolve(workspace,'starter/src/projection.ts')).href);const now=process.hrtime.bigint.bind(process.hrtime);const started=now();const limits={maxSessions:160,maxBatchEvents:64,maxBatchBytes:65536};let events=0,commits=0;
for(let iteration=0;iteration<4;iteration++){
 let seq=0;const expected=new Map();let persisted;let projection=new SessionProjection('benchmark-'+iteration,limits);
 for(let epoch=1;epoch<=3;epoch++){
  const source=(async function*(){let batch=[];for(let session=0;session<160;session++){const id='session-'+String(session).padStart(3,'0');const messages=24+(session%3);batch.push({seq:++seq,session:id,epoch,kind:'open',at:-seq});let bytes=0;const lastAt=-seq;for(let m=0;m<messages;m++){const payload=m%2?'é':'长会话🙂';bytes+=m%2?2:13;batch.push({seq:++seq,session:id,epoch,kind:'message',at:-seq,payload});if(batch.length===64){yield batch;batch=[];}}batch.push({seq:++seq,session:id,epoch,kind:'close',at:-seq});expected.set(id,{id,epoch,open:false,messages,bytes,lastAt});if(batch.length>=60){yield batch;batch=[];}}if(batch.length)yield batch;})();
  await replayProjection(projection,source,async cp=>{commits++;persisted=JSON.stringify(cp);await Promise.resolve();});assert.equal(projection.snapshot().through,seq);assert.deepEqual(projection.snapshot().rows,[...expected.values()]);assert.ok(persisted.length<40000);
  projection=new SessionProjection('benchmark-'+iteration,limits,JSON.parse(persisted));
 }
 events+=seq;
}
console.log(JSON.stringify({schemaVersion:'0.1.0',taskId:'PERF-04',workloadVersion:'0.3.0',durationMs:Number(now()-started)/1e6,peakRssBytes:process.resourceUsage().maxRSS*1024,correctnessPassed:true,inputEvents:events,sessions:160,iterations:4,commits,measurementTrust:'in-process-diagnostic',includesSemanticAssertions:true,note:'新增流式投影与检查点主路径；外部受信计时用于配对，同进程值仅诊断。'}));
