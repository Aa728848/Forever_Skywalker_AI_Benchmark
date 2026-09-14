import test from 'node:test';
import assert from 'node:assert/strict';
import { IdempotentWriter, IdempotencyConflictError } from '../starter/src/idempotent-writer.ts';
function deferred<T>() { let resolve!: (value:T)=>void;let reject!:(error:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}; }
test('hidden/conflicting-inflight-body-never-commits',async()=>{
  const writer=new IdempotentWriter<string>();const wait=deferred<string>();let writes=0;
  const first=writer.write('k','initial',()=>wait.promise);const conflict=writer.write('k','different',async()=>{writes++;return 'bad'});
  const rejected=assert.rejects(conflict,IdempotencyConflictError);wait.resolve('ok');await Promise.all([first,rejected]);assert.equal(writes,0);
});
test('hidden/failed-write-retries-without-cross-key-blocking',async()=>{
  const writer=new IdempotentWriter<string>();const wait=deferred<string>();const fault=new Error('write failed');
  const first=writer.write('__proto__','a',()=>wait.promise);const failed=assert.rejects(first,error=>error===fault);
  assert.equal(await writer.write('other','b',async body=>body),'b');wait.reject(fault);await failed;
  assert.equal(await writer.write('__proto__','a',async()=> 'recovered'),'recovered');
});
