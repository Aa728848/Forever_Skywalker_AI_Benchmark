import test from 'node:test';
import assert from 'node:assert/strict';

import { AsyncPluginHost, PluginSetupError, ScopeClosedError, type SetupContext } from '../starter/src/async-plugins.ts';
const turn=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};

test('hidden/reentrant-dispose-joins-unpublished-setup',async()=>{
  const host=new AsyncPluginHost();const setupGate=Promise.withResolvers<void>();const cleanupGate=Promise.withResolvers<void>();const cleanupStarted=Promise.withResolvers<void>();
  let disposal!:Promise<void>;let settled=false;let live=0;
  const replacing=host.replace({id:'pending',async setup(ctx){disposal=host.dispose();void disposal.then(()=>{settled=true;});await setupGate.promise;live++;ctx.defer(async()=>{cleanupStarted.resolve();await cleanupGate.promise;live--;});}});
  await turn();const early=settled;setupGate.resolve();await turn();const beforeCleanup=settled;cleanupGate.resolve();await Promise.all([replacing,disposal]);
  assert.equal(early,false);assert.equal(beforeCleanup,false);assert.equal(live,0);assert.equal(host.active,null);
});

test('hidden/reentrant-new-selection-is-visible-before-publication',async()=>{
  const host=new AsyncPluginHost();let nested!:Promise<unknown>;const released:string[]=[];
  const outer=host.replace({id:'outer',setup(ctx){ctx.defer(()=>{released.push('outer');});nested=host.replace({id:'inner',setup(ctx){ctx.defer(()=>{released.push('inner');});}});}});
  const [result]=await Promise.all([outer,nested]);assert.equal(result.status,'superseded');assert.equal(host.active,'inner');assert.deepEqual(released,['outer']);await host.dispose();assert.deepEqual(released,['outer','inner']);
});

test('hidden/same-active-selection-cancels-pending-intent',async()=>{
  const host=new AsyncPluginHost();let count=0;const current={id:'a',setup(){count++;}};await host.replace(current);
  const gate=Promise.withResolvers<void>();const pending=host.replace({id:'b',async setup(){await gate.promise;}});
  await host.replace(current);gate.resolve();const stale=await pending;assert.equal(count,1);assert.equal(stale.status,'superseded');assert.equal(host.active,'a');await host.dispose();
});

test('hidden/committed-plugin-survives-previous-cleanup-error',async()=>{
  const host=new AsyncPluginHost();let nextClean=0;await host.replace({id:'a',setup(ctx){ctx.defer(()=>{throw new Error('old cleanup');});}});
  const outcome=await host.replace({id:'b',setup(ctx){ctx.defer(()=>{nextClean++;});}}).catch(error=>error);
  assert.ok(outcome instanceof AggregateError);assert.equal(host.active,'b');await host.dispose();assert.equal(nextClean,1);
});

test('hidden/seeded-completion-order-has-one-owner',async()=>{
  for(const seed of [7,23,71,109]){const host=new AsyncPluginHost();const gates=Array.from({length:12},()=>Promise.withResolvers<void>());const released:number[]=[];
    const pending=gates.map((gate,index)=>host.replace({id:String(index),async setup(ctx){ctx.defer(()=>{released.push(index);});await gate.promise;}}));
    let state=seed;const order=Array.from({length:12},(_,i)=>i);for(let i=11;i>0;i--){state=(Math.imul(state,1664525)+1013904223)>>>0;const at=state%(i+1);[order[i],order[at]]=[order[at]!,order[i]!];}
    for(const i of order){gates[i]!.resolve();await turn();}const results=await Promise.all(pending);
    assert.equal(host.active,'11');assert.equal(results.filter(x=>x.status==='active').length,1);assert.equal(released.length,11);await host.dispose();assert.deepEqual(released.sort((a,b)=>a-b),Array.from({length:12},(_,i)=>i));
  }
});
