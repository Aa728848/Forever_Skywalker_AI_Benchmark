import test from 'node:test';
import assert from 'node:assert/strict';
import {LockManager} from '../starter/src/locks.ts';
const turn=async()=>{for(let i=0;i<6;i++)await Promise.resolve();};
test('public/atomic-bundle-and-disjoint-progress',async()=>{
 const locks=new LockManager();const heldA=await locks.acquire('a');const held=await locks.acquire('b');const batch=locks.acquireMany(['a','b']);assert.equal(locks.queueLength,1);heldA();let freeA=false;const probe=locks.acquire('a').then(release=>{freeA=true;release();});
 // An earlier conflicting bundle reserves queue order even before it owns either resource.
 const unrelated=await locks.acquire('z');unrelated();await turn();assert.equal(freeA,false);assert.equal(locks.queueLength,2);held();const release=await batch;await turn();assert.equal(freeA,false);release();await probe;assert.equal(locks.queueLength,0);
});
test('public/cancel-unblocks-overlap',async()=>{
 const locks=new LockManager();const held=await locks.acquire('a');const controller=new AbortController();const reason=new Error('cancel waiting');const pending=locks.acquireMany(['a','b'],controller.signal);let observed:unknown='pending';void pending.then(()=>{observed='granted';},error=>{observed=error;});let acquired=false;const next=locks.acquire('b').then(release=>{acquired=true;release();});controller.abort(reason);await turn();assert.equal(observed,reason);assert.equal(acquired,true);held();await next;assert.equal(locks.queueLength,0);
});
