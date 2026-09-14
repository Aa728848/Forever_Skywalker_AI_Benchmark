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

test('hidden/regression-settlement-and-rebaseline',async()=>{
const client=new ClientAssistantStream();client.replace([],baseline(packed(['one']),1));const durable=settlement(2);assert.equal(client.acceptDurable(durable),undefined);assert.deepEqual(client.acceptDurable(durable),{type:'rebaseline'});assert.deepEqual(client.acceptFrame({type:'end',attemptId:'attempt',revision:3,index:1,outcome:{kind:'committed',eventType:'assistant/attempt',seq:2}}),{type:'settlement',attemptId:'attempt',entry:durable});assert.equal(client.acceptFrame({type:'end',attemptId:'attempt',revision:3,index:1,outcome:{kind:'committed',eventType:'assistant/attempt',seq:2}}),undefined);client.replace([]);assert.equal(client.acceptFrame(frame(1)),undefined);
});

test('hidden/resources-large-compact-prefix',async()=>{
const compact=packed(Array.from({length:100000},(_,i)=>String(i%10)));assert.equal(compact.length,1);const client=new ClientAssistantStream();const visible=client.replace([],baseline(compact,100));assert.equal(visible.length,100);assert.equal(client.acceptFrame(frame(100)).type,'transient');assert.equal(assembleAssistantStream(compact).blocks()[0].text.length,100000);
});

test('hidden/state-foreign-attempt-isolation',async()=>{
const client=new ClientAssistantStream();client.replace([],baseline(packed(['a','b','c']),2));assert.equal(client.acceptFrame({...frame(2),attemptId:'foreign'}),undefined);assert.deepEqual(client.acceptFrame(frame(4)),{type:'rebaseline'});assert.equal(client.acceptFrame(frame(2,'c')).type,'transient');
});
