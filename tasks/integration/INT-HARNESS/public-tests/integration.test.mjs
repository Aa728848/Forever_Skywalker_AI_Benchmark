import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks,stripTypeScriptTypes} from 'node:module';
import {readFileSync} from 'node:fs';
const ROOT=new URL('../starter/',import.meta.url);
const aliases={"@deepseek-ai/dsh-llm/assistant-stream":"packages/llm/llm/src/assistant-stream.ts","@deepseek-ai/dsh-util-values":"packages/util/values/src/index.ts","@deepseek-ai/dsh-brand":"packages/util/brand/src/index.ts","@deepseek-ai/dsh-util-crypto":"packages/util/crypto/src/index.ts"};
registerHooks({resolve(specifier,context,next){const path=aliases[specifier];return path?{url:new URL(path,ROOT).href,shortCircuit:true}:next(specifier,context);},load(url,context,next){if(url.startsWith(ROOT.href)&&url.endsWith('.ts'))return{format:'module',source:stripTypeScriptTypes(readFileSync(new URL(url),'utf8'),{mode:'transform'}),shortCircuit:true};return next(url,context);}});
const {ClientAssistantStream}=await import(new URL('packages/api/session-controller/src/client/sessions/assistant-stream.ts',ROOT));
const {AssistantStreamAccumulator,expandAssistantStream,assembleAssistantStream}=await import(new URL('packages/llm/llm/src/assistant-stream.ts',ROOT));
const {BlockAssembler}=await import(new URL('packages/llm/llm/src/assembler.ts',ROOT));
const ordinary=seq=>({type:'event',event:{type:'turn/start',seq,time:seq,data:{turn:1}}});
function packed(parts){const accumulator=new AssistantStreamAccumulator();parts.forEach((text,index)=>accumulator.push({time:20+index,chunk:{type:'text-delta',index:0,text}}));return accumulator.snapshot();}
const baseline=(stream,nextIndex)=>({revision:nextIndex+1,activeAttempt:{attemptId:'attempt',startedAfterSeq:0,turn:1,step:1,nextIndex,stream}});
const frame=(index,text='suffix')=>({type:'chunk',attemptId:'attempt',revision:index+2,index,time:50+index,chunk:{type:'text-delta',index:0,text}});
const settlement=seq=>({type:'event',event:{type:'assistant/attempt',seq,time:seq,data:{turn:1,step:1,stream:[]}}});

test('public/behavior-reconnect-prefix-and-assembly',async()=>{
const compact=packed(['first','second']);const client=new ClientAssistantStream();const visible=client.replace([ordinary(0)],baseline(compact,1));assert.equal(visible.length,2);const tail=client.acceptFrame(frame(1,'second'));assert.equal(tail.type,'transient');const assembler=new BlockAssembler();for(const item of visible)if(item.type==='transient')assembler.push(item.event.data.chunk);assembler.push(tail.entry.event.data.chunk);assert.deepEqual(assembler.blocks(),assembleAssistantStream(compact).blocks());
});

test('public/boundary-zero-prefix-and-invalid-compact',async()=>{
const client=new ClientAssistantStream();assert.deepEqual(client.replace([],baseline(packed(['one']),0)),[]);assert.throws(()=>expandAssistantStream([{type:'text-chunks',time0:1,index:0,dt:[],texts:['a','b']}]),TypeError);
});

test('public/state-gap-cannot-publish',async()=>{
const client=new ClientAssistantStream();client.replace([],baseline(packed(['one']),1));assert.deepEqual(client.acceptFrame(frame(3)),{type:'rebaseline'});const result=client.acceptFrame(frame(1,'two'));assert.equal(result.type,'transient');assert.equal(result.entry.event.data.chunk.text,'two');
});
