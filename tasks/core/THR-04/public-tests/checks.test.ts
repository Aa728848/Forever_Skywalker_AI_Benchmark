import test from 'node:test';
import assert from 'node:assert/strict';
import * as candidate from '../starter/src/publisher.ts';
function release(buffer:SharedArrayBuffer):void{const gate=new Int32Array(buffer);Atomics.store(gate,0,1);Atomics.notify(gate,0);}

test('public/state-old-generation-finishes-late', async () => {
  const gate=new SharedArrayBuffer(4);const p=new candidate.Publisher();const old=p.build(1,[{id:'old',value:1,gate}]);try{assert.equal(await p.build(2,[{id:'new',value:2}]),true);}finally{release(gate);}assert.equal(await old,false);assert.deepEqual(p.snapshot(),{generation:2,values:new Map([['new',4]])});
});

test('public/state-cancel-preserves-confirmed', async () => {
  const p=new candidate.Publisher();await p.build(1,[{id:'confirmed',value:3}]);const gate=new SharedArrayBuffer(4);const cancel=new AbortController();const work=p.build(2,[{id:'blocked',value:9,gate}],cancel.signal);cancel.abort();assert.equal(await work,false);assert.deepEqual(p.snapshot(),{generation:1,values:new Map([['confirmed',6]])});
});

test('public/boundary-duplicate', async () => {
  const p=new candidate.Publisher();await assert.rejects(p.build(1,[{id:'a',value:1},{id:'a',value:2}]),RangeError);await p.build(1,[]);await assert.rejects(p.build(1,[]),RangeError);
});
