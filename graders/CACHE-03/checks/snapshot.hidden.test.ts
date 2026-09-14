import test from 'node:test';
import assert from 'node:assert/strict';
import {VersionedCache} from '../starter/src/cache.ts';
function gate(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const turn=()=>new Promise(resolve=>setImmediate(resolve));
test('hidden/multikey-retries-invalidated-cut',async()=>{
 const calls=[];const cache=new VersionedCache({load(key){const g=gate();calls.push({key,...g});return g.promise;}});const keys=['a','b','a'];const pending=cache.getMany(keys);keys[0]='changed';assert.deepEqual(calls.map(c=>c.key),['a','b']);cache.invalidate('a');calls[0].resolve('old-a');calls[1].resolve('b');await turn();assert.equal(calls.length,3);assert.equal(calls[2].key,'a');calls[2].resolve('fresh-a');assert.deepEqual(await pending,['fresh-a','b','fresh-a']);
});
test('hidden/old-rejection-preserves-new-flight',async()=>{
 const calls=[];const cache=new VersionedCache({load(){const g=gate();calls.push(g);return g.promise;}});const old=cache.get('x');const failure={code:'old-failure'};const rejected=assert.rejects(old,e=>e===failure);cache.invalidate('x');const fresh=cache.get('x');calls[0].reject(failure);await rejected;assert.equal(cache.get('x'),fresh);calls[1].resolve('new');assert.equal(await fresh,'new');assert.equal(calls.length,2);
});
test('hidden/rejected-current-generation-is-retryable',async()=>{
 const fault=new Error('transient');let calls=0;const cache=new VersionedCache({load(){return ++calls===1?Promise.reject(fault):Promise.resolve('retry');}});await assert.rejects(cache.getMany(['x','x']),e=>e===fault);assert.deepEqual(await cache.getMany(['x']),['retry']);assert.equal(calls,2);
});
test('hidden/synchronous-source-error-is-a-rejection',async()=>{const error={reason:'sync'};const cache=new VersionedCache({load(){throw error;}});let result;assert.doesNotThrow(()=>{result=cache.get('x');});await assert.rejects(result,e=>e===error);});
test('hidden/new-success-survives-late-old-success',async()=>{const calls=[];const cache=new VersionedCache({load(){const g=gate();calls.push(g);return g.promise;}});const old=cache.get('x');cache.invalidate('x');const fresh=cache.get('x');calls[1].resolve('new');await fresh;calls[0].resolve('old');await old;await turn();assert.equal(cache.get('x'),fresh);assert.equal(await cache.get('x'),'new');});
