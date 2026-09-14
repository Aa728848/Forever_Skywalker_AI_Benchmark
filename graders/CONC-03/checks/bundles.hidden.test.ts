import test from 'node:test';
import assert from 'node:assert/strict';
import {LockManager} from '../starter/src/locks.ts';
const turn=async()=>{for(let i=0;i<6;i++)await Promise.resolve();};
test('hidden/conflict-transitivity-and-disjoint-bypass',async()=>{
 const locks=new LockManager();const held=await locks.acquire('a');const heldB=await locks.acquire('b');const seen:string[]=[];const releases:(()=>void)[]=[];
 const one=locks.acquireMany(['a','b']).then(r=>{seen.push('ab');releases.push(r);});const two=locks.acquireMany(['b','c']).then(r=>{seen.push('bc');releases.push(r);});const three=locks.acquire('c').then(r=>{seen.push('c');r();});const independent=await locks.acquire('z');independent();await turn();assert.deepEqual(seen,[]);assert.equal(locks.queueLength,3);heldB();held();await one;assert.deepEqual(seen,['ab']);releases.shift()!();await two;assert.deepEqual(seen,['ab','bc']);releases.shift()!();await three;assert.deepEqual(seen,['ab','bc','c']);
});
test('hidden/granted-abort-and-idempotent-bundle-release',async()=>{
 const locks=new LockManager(),signal=new AbortController();const keys=['x','x','y'];const release=await locks.acquireMany(keys,signal.signal);assert.deepEqual(keys,['x','x','y']);signal.abort();let granted=false;const next=locks.acquireMany(['y','x']).then(r=>{granted=true;return r;});await turn();assert.equal(granted,false);release();const free=await next;release();let third=false;const last=locks.acquire('x').then(r=>{third=true;r();});await turn();assert.equal(third,false);free();await last;assert.equal(locks.queueLength,0);
});
test('hidden/preaborted-and-empty-request',async()=>{const locks=new LockManager(),abort=new AbortController();abort.abort('stop');await assert.rejects(locks.acquireMany(['x'],abort.signal),e=>e==='stop');const empty=await locks.acquireMany([]);empty();empty();assert.equal(locks.queueLength,0);const next=await locks.acquire('x');next();});
