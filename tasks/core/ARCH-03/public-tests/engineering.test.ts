import test from 'node:test';
import assert from 'node:assert/strict';

import {RepositoryRouter,ReadCancelledError,AdapterReplacedError} from '../starter/src/repository-router.ts';
import type {V2Result} from '../starter/src/repository.ts';
const value:V2Result={status:'ok',durationSeconds:0.25,body:'data'};const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};

test('public/subscriber-cancel-does-not-abort-other-readers',async()=>{const gate=Promise.withResolvers<V2Result>();let calls=0;let underlying!:AbortSignal;const router=new RepositoryRouter({load(_id,signal){calls++;underlying=signal;return gate.promise;}});const controller=new AbortController();const first=router.read('key',controller.signal).catch(error=>error);const second=router.read('key');controller.abort();const aborted=underlying.aborted;gate.resolve(value);const [cancelled,result]=await Promise.all([first,second]);assert.ok(cancelled instanceof ReadCancelledError);assert.equal(aborted,false);assert.equal(calls,1);assert.deepEqual(result,{ok:true,durationMs:250,body:'data'});});

test('public/old-adapter-completion-cannot-clear-new-inflight',async()=>{const old=Promise.withResolvers<V2Result>(),next=Promise.withResolvers<V2Result>();let oldSignal!:AbortSignal,newCalls=0;const router=new RepositoryRouter({load(_id,signal){oldSignal=signal;return old.promise;}});const first=router.read('key').catch(error=>error);router.replace({load(){newCalls++;return next.promise;}});const second=router.read('key');old.resolve(value);await flush();const third=router.read('key');next.resolve({...value,body:'new'});const results=await Promise.all([first,second,third]);assert.ok(results[0] instanceof AdapterReplacedError);assert.equal(oldSignal.aborted,true);assert.equal(newCalls,1);assert.equal((results[1] as {body:string}).body,'new');assert.deepEqual(results[1],results[2]);});
