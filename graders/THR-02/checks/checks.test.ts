import test from 'node:test';
import assert from 'node:assert/strict';
import * as candidate from '../starter/src/thread-pool.ts';
function release(buffer:SharedArrayBuffer):void{const gate=new Int32Array(buffer);Atomics.store(gate,0,1);Atomics.notify(gate,0);}

test('hidden/resource-real-bounded-workers', async () => {
  const workers=await import('node:worker_threads');const {syncBuiltinESMExports}=await import('node:module');const Original=workers.default.Worker;const made:InstanceType<typeof Original>[]=[];let active=0,peak=0,exited=0;workers.default.Worker=class extends Original{constructor(...args:ConstructorParameters<typeof Original>){super(...args);made.push(this);peak=Math.max(peak,++active);this.once('exit',()=>{active--;exited++;});}};syncBuiltinESMExports();const gate=new SharedArrayBuffer(4);const pool=new candidate.ThreadPool(2);try{const pending=Array.from({length:7},(_,i)=>pool.submit({id:String(i),value:i,gate}));await new Promise(resolve=>setImmediate(resolve));release(gate);assert.deepEqual(await Promise.all(pending),[0,2,4,6,8,10,12]);await pool.close();assert.equal(made.length,7);assert.ok(peak<=2,'observed worker peak '+peak);assert.equal(exited,made.length);}finally{release(gate);await pool.close();workers.default.Worker=Original;syncBuiltinESMExports();await Promise.all(made.map(worker=>worker.terminate()));}
});

test('hidden/state-failed-lane-recovers', async () => {
  const pool=new candidate.ThreadPool(1);try{const results=await Promise.allSettled([pool.submit({id:'1',value:1,crash:true}),pool.submit({id:'2',value:2,crash:true}),pool.submit({id:'3',value:3})]);assert.deepEqual(results.map(r=>r.status),['rejected','rejected','fulfilled']);assert.equal((results[2] as PromiseFulfilledResult<number>).value,6);}finally{await pool.close();}await assert.rejects(pool.submit({id:'closed',value:9}),/closed/);
});
