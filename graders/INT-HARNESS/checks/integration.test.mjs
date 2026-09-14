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

test('hidden/resources-prefix-does-not-read-tail', () => {
  function guarded(values, allowed) {
    return new Proxy(values, { get(target, key, receiver) {
      if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) assert.ok(Number(key) < allowed, `读取了前缀外成员 ${key}`);
      return Reflect.get(target, key, receiver);
    } });
  }
  for (const type of ['text-chunks', 'reasoning-chunks', 'tool-call-chunks']) {
    const record = { type, time0: 10, index: 2, dt: guarded(Array(9999).fill(2), 2) };
    if (type === 'tool-call-chunks') Object.assign(record, { id: 'call-x', name: 'tool', args: guarded(Array(10000).fill('x'), 3) });
    else record.texts = guarded(Array(10000).fill('中'), 3);
    const client = new ClientAssistantStream();
    const visible = client.replace([], baseline([record], 3));
    assert.equal(visible.length, 3);
    assert.deepEqual(visible.map(item => item.event.time), [10, 12, 14]);
  }
  const unavailable = new Proxy([packed(['tail'])[0]], { get(target, key, receiver) {
    if (key === '0') throw new Error('零前缀读取了历史记录');
    return Reflect.get(target, key, receiver);
  } });
  assert.deepEqual(new ClientAssistantStream().replace([], baseline(unavailable, 0)), []);
});

test('hidden/behavior-mixed-packed-prefix-oracle', () => {
  for (let seed = 1; seed <= 24; seed++) {
    const accumulator = new AssistantStreamAccumulator();
    let time = seed;
    for (let group = 0; group < 4; group++) {
      for (let member = 0; member < 1 + (seed + group) % 5; member++) {
        const chunk = group === 0 ? { type: 'text-delta', index: 0, text: `${seed}:${member}` }
          : group === 1 ? { type: 'reasoning-delta', index: 1, text: `思考${member}` }
          : group === 2 ? { type: 'tool-call-delta', index: 2, id: 'call-x', argumentsDelta: `${member}`, ...(seed % 2 ? { name: 'tool' } : {}) }
          : { type: 'usage', inputTokens: member, outputTokens: seed };
        accumulator.push({ time: time += group + 1, chunk });
      }
    }
    const compact = accumulator.snapshot();
    const full = expandAssistantStream(compact);
    for (const take of [0, 1, Math.floor(full.length / 2), full.length - 1, full.length]) {
      const client = new ClientAssistantStream();
      const visible = client.replace([ordinary(seed)], baseline(compact, take));
      assert.deepEqual(visible.slice(1).map(item => ({ time: item.event.time, chunk: item.event.data.chunk })), full.slice(0, take));
      assert.deepEqual(client.acceptFrame(frame(take + 2)), { type: 'rebaseline' });
      const accepted = client.acceptFrame(frame(take, 'current'));
      assert.equal(accepted.type, 'transient');
      assert.equal(accepted.entry.event.data.chunk.text, 'current');
      assert.deepEqual(client.acceptFrame(frame(take)), { type: 'rebaseline' });
      assert.equal(client.acceptFrame(frame(take + 1)).type, 'transient');
    }
  }
});
