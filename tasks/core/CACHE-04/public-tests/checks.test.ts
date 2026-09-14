import test from 'node:test';
import assert from 'node:assert/strict';
import * as candidate from '../starter/src/persistent-cache.ts';
function deferred<T>(){let resolve!:(value:T)=>void;let reject!:(reason:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const scope={workspace:'w',model:'m',rules:'1'};
function memory(text:string|null=null){let reads=0;let fail=false;return {get reads(){return reads;},get text(){return text;},fail(){fail=true;},storage:{async read(){reads++;return text;},async writeAtomic(value:string){if(fail){fail=false;throw new Error('disk full');}text=value;}}};}

test('public/cold-start-single-read', async () => {
  const gate=deferred<string|null>();let reads=0;const cache=new candidate.PersistentCache({read(){reads++;return gate.promise;},async writeAtomic(){}},scope);const readsPending=Array.from({length:20},()=>cache.get('x'));assert.equal(reads,1);gate.resolve(null);assert.deepEqual(await Promise.all(readsPending),Array(20).fill(undefined));
});

test('public/state-write-failure', async () => {
  const disk=memory();const cache=new candidate.PersistentCache(disk.storage,scope);await cache.set('x','old');disk.fail();await assert.rejects(cache.set('x','new'),/disk full/);assert.equal(await cache.get('x'),'old');await cache.set('x','retry');assert.equal(await cache.get('x'),'retry');
});

test('public/domain-isolation', async () => {
  const disk=memory();await new candidate.PersistentCache(disk.storage,scope).set('x','a');const other=new candidate.PersistentCache(disk.storage,{...scope,model:'different'});assert.equal(await other.get('x'),undefined);await other.set('x','b');assert.equal(await new candidate.PersistentCache(disk.storage,scope).get('x'),'a');
});
