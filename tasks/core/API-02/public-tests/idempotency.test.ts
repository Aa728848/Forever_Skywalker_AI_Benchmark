import test from 'node:test';
import assert from 'node:assert/strict';
import { IdempotentWriter, IdempotencyConflictError } from '../starter/src/idempotent-writer.ts';
function deferred<T>() { let resolve!: (value:T)=>void;let reject!:(error:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}; }
test('public/inflight-idempotent-write',async()=>{
  const writer=new IdempotentWriter<object>();const wait=deferred<object>();let calls=0;const commit=async()=>{calls++;return wait.promise};
  const first=writer.write('key','body',commit), second=writer.write('key','body',commit);const value={id:42};wait.resolve(value);
  const results=await Promise.all([first,second]);assert.equal(calls,1);assert.equal(results[0],value);assert.equal(results[1],value);
  assert.equal(await writer.write('key','body',commit),value);assert.equal(calls,1);
});
test('public/idempotency-conflict-preserves-original',async()=>{
  const writer=new IdempotentWriter<string>();await writer.write('key','one',async body=>body);
  await assert.rejects(writer.write('key','two',async body=>body),IdempotencyConflictError);
  assert.equal(await writer.write('key','one',async()=>{throw new Error('不能再次提交')}),'one');
});
