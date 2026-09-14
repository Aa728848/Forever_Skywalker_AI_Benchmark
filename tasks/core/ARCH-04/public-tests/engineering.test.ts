import test from 'node:test';
import assert from 'node:assert/strict';

import { AsyncPluginHost, PluginSetupError, ScopeClosedError, type SetupContext } from '../starter/src/async-plugins.ts';

test('public/async-activation-rollback-owns-partial-resources',async()=>{
  const host=new AsyncPluginHost();const events:string[]=[];await host.replace({id:'old',setup(ctx){ctx.defer(()=>{events.push('old');});}});
  const failure=new Error('setup failed');const outcome=await host.replace({id:'bad',async setup(ctx){ctx.defer(()=>{events.push('partial');});await Promise.resolve();throw failure;}}).catch(error=>error);
  assert.ok(outcome instanceof PluginSetupError);assert.equal(outcome.id,'bad');assert.equal(outcome.errors[0],failure);assert.equal(host.active,'old');assert.deepEqual(events,['partial']);await host.dispose();assert.deepEqual(events,['partial','old']);
});

test('public/latest-intent-fences-out-of-order-setup',async()=>{
  const host=new AsyncPluginHost();const gate=Promise.withResolvers<void>();let context!:SetupContext;let cleaned=0;
  const slow=host.replace({id:'slow',async setup(ctx){context=ctx;ctx.defer(()=>{cleaned++;});await gate.promise;}});
  const fast=await host.replace({id:'fast',setup(){}});const aborted=context.signal.aborted;gate.resolve();const stale=await slow;
  assert.equal(fast.status,'active');assert.equal(stale.status,'superseded');assert.equal(host.active,'fast');assert.equal(aborted,true);assert.equal(cleaned,1);await host.dispose();
});

test('public/cleanup-lifo-continues-after-failure',async()=>{
  const host=new AsyncPluginHost();const events:number[]=[];await host.replace({id:'resources',setup(ctx){for(const n of [1,2,3])ctx.defer(async()=>{await Promise.resolve();events.push(n);if(n===2)throw new Error('cleanup');});}});
  const result=await host.dispose().catch(error=>error);assert.ok(result instanceof AggregateError);assert.deepEqual(events,[3,2,1]);assert.equal(host.active,null);await host.dispose().catch(()=>{});assert.deepEqual(events,[3,2,1]);
});

test('public/scope-closes-registration-after-setup',async()=>{
  const host=new AsyncPluginHost();let ctx!:SetupContext;await host.replace({id:'a',setup(value){ctx=value;}});
  assert.throws(()=>ctx.defer(()=>{}),ScopeClosedError);await host.dispose();await assert.rejects(host.replace({id:'b',setup(){}}),ScopeClosedError);
});
