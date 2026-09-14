import test from 'node:test';
import assert from 'node:assert/strict';
import * as candidate from '../starter/src/publisher.ts';
function release(buffer:SharedArrayBuffer):void{const gate=new Int32Array(buffer);Atomics.store(gate,0,1);Atomics.notify(gate,0);}

test('hidden/resource-failure-cleans-peers', async () => {
  const workers=await import('node:worker_threads');const {syncBuiltinESMExports}=await import('node:module');const Original=workers.default.Worker;const made:InstanceType<typeof Original>[]=[];let exited=0;workers.default.Worker=class extends Original{constructor(...args:ConstructorParameters<typeof Original>){super(...args);made.push(this);this.once('exit',()=>exited++);}};syncBuiltinESMExports();try{const p=new candidate.Publisher();await assert.rejects(p.build(1,[{id:'bad',value:0,crash:true},{id:'held',value:9,gate:new SharedArrayBuffer(4)}]));assert.equal(made.length,2);assert.equal(exited,2);assert.deepEqual(p.snapshot(),{generation:null,values:new Map()});assert.equal(await p.build(2,[{id:'recovered',value:4}]),true);assert.equal(exited,3);}finally{workers.default.Worker=Original;syncBuiltinESMExports();await Promise.all(made.map(worker=>worker.terminate()));}
});

test('hidden/state-three-generations-and-copy', async () => {
  const p=new candidate.Publisher();const one=new SharedArrayBuffer(4),two=new SharedArrayBuffer(4);const first=p.build(1,[{id:'one',value:1,gate:one}]);const second=p.build(2,[{id:'two',value:2,gate:two}]);try{assert.equal(await p.build(3,[{id:'latest',value:3}]),true);}finally{release(two);release(one);}assert.deepEqual(await Promise.all([first,second]),[false,false]);const copy=p.snapshot().values as Map<string,number>;copy.set('fake',999);assert.deepEqual([...p.snapshot().values],[['latest',6]]);
});
