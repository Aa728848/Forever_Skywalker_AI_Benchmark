import test from 'node:test';
import assert from 'node:assert/strict';
import * as candidate from '../starter/src/thread-pool.ts';
function release(buffer:SharedArrayBuffer):void{const gate=new Int32Array(buffer);Atomics.store(gate,0,1);Atomics.notify(gate,0);}

test('public/results-and-job-error', async () => {
  const pool=new candidate.ThreadPool(2);try{const all=await Promise.allSettled([pool.submit({id:'a',value:3}),pool.submit({id:'bad',value:1,crash:true}),pool.submit({id:'c',value:5})]);assert.deepEqual(all.map(result=>result.status),['fulfilled','rejected','fulfilled']);assert.equal((all[0] as PromiseFulfilledResult<number>).value,6);assert.equal((all[2] as PromiseFulfilledResult<number>).value,10);}finally{await pool.close();}
});

test('public/state-close-drains', async () => {
  const gate=new SharedArrayBuffer(4);const pool=new candidate.ThreadPool(1);const pending=pool.submit({id:'held',value:4,gate});let done=false;const closing=pool.close().then(()=>{done=true;});const rejected=pool.submit({id:'late',value:2}).then(()=>false,()=>true);await new Promise(resolve=>setImmediate(resolve));const wasDone=done;release(gate);await pending;await closing;assert.equal(wasDone,false);assert.equal(await rejected,true);await pool.close();
});

test('public/boundary-size', async () => {
  for(const size of [0,1.5,9])assert.throws(()=>new candidate.ThreadPool(size),RangeError);
});
