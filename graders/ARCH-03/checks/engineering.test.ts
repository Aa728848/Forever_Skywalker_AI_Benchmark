import test from 'node:test';
import assert from 'node:assert/strict';

import {RepositoryRouter,ReadCancelledError,AdapterReplacedError} from '../starter/src/repository-router.ts';
import {AdapterError,type V2Result} from '../starter/src/repository.ts';
const value:V2Result={status:'ok',durationSeconds:0.25,body:'data'};const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};

test('hidden/last-reader-cancel-detaches-before-retry',async()=>{const gates=[Promise.withResolvers<V2Result>(),Promise.withResolvers<V2Result>()];const signals:AbortSignal[]=[];const router=new RepositoryRouter({load(_id,signal){signals.push(signal);return gates[signals.length-1]!.promise;}});const controller=new AbortController();const first=router.read('key',controller.signal).catch(error=>error);controller.abort();const second=router.read('key');gates[0]!.resolve(value);gates[1]!.resolve(value);const [error]=await Promise.all([first,second]);assert.ok(error instanceof ReadCancelledError);assert.equal(signals.length,2);assert.equal(signals[0]!.aborted,true);assert.equal(signals[1]!.aborted,false);});

test('hidden/adapter-failure-normalization-and-retry',async()=>{for(const synchronous of [true,false]){let calls=0;const router=new RepositoryRouter({load(){if(calls++===0){if(synchronous)throw new Error('raw');return Promise.reject(new Error('raw'));}return Promise.resolve({status:'missing',durationSeconds:0.001,body:'ignored'});}});await assert.rejects(router.read('key'),error=>error instanceof AdapterError&&error.id==='key');assert.deepEqual(await router.read('key'),{ok:false,durationMs:1,body:null});}});

test('hidden/already-aborted-read-never-loads',async()=>{let calls=0;const router=new RepositoryRouter({async load(){calls++;return value;}});const controller=new AbortController();controller.abort();await assert.rejects(router.read('key',controller.signal),ReadCancelledError);assert.equal(calls,0);});

test('hidden/synchronous-adapter-reentry-cannot-publish-old-read',async()=>{let router!:RepositoryRouter;router=new RepositoryRouter({load(){router.replace({async load(){return {...value,body:'current'};}});return Promise.resolve(value);}});const old=await router.read('key').catch(error=>error);assert.ok(old instanceof AdapterReplacedError);assert.equal((await router.read('key')).body,'current');});
