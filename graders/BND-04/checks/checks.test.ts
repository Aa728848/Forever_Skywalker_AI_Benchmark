import test from 'node:test';
import assert from 'node:assert/strict';
import * as candidate from '../starter/src/bounded.ts';
const limits={maxBytes:1000000,maxDepth:30000,maxNodes:100000};

test('hidden/nodes-before-materialization', async () => {
  const parse=JSON.parse;let calls=0;
  JSON.parse=(...args)=>{calls++;return parse(...args);};
  try { assert.throws(()=>candidate.parseBounded('{"a":[1,true]}',{...limits,maxNodes:4}),e=>e instanceof candidate.ParseLimitError && e.reason==='nodes' && e.offset===8);assert.equal(calls,0); } finally {JSON.parse=parse;}
});

test('hidden/resource-deep-stack-safe', async () => {
  const depth=20000;const value=candidate.parseBounded('['.repeat(depth)+'0'+']'.repeat(depth),limits);let cursor=value;for(let i=0;i<depth;i++) {assert.ok(Array.isArray(cursor));cursor=cursor[0];}assert.equal(cursor,0);
});

test('hidden/boundary-invalid-input', async () => {
  for(const text of ['{"x":}', '"unterminated', '[1,]', '{]']) assert.throws(()=>candidate.parseBounded(text,limits),SyntaxError);
  assert.throws(()=>candidate.parseBounded('1',{...limits,maxDepth:-1}),RangeError);
  assert.equal(candidate.parseBounded('0',{maxBytes:1,maxDepth:0,maxNodes:1}),0);
});

test('hidden/differential-budget-boundary', async () => {
  for(let n=1;n<=30;n++){const value=Array.from({length:n},(_,i)=>({['k'+i]:i%2?'😀':'[]'}));const text=JSON.stringify(value);assert.deepEqual(candidate.parseBounded(text,{maxBytes:Buffer.byteLength(text),maxDepth:2,maxNodes:1+3*n}),value);}
});

test('hidden/state-rejection-does-not-leak',()=>{
  assert.throws(()=>candidate.parseBounded('[[0]]',{...limits,maxDepth:1}),candidate.ParseLimitError);
  assert.deepEqual(candidate.parseBounded('{"clean":[1,2]}',limits),{clean:[1,2]});
  assert.throws(()=>candidate.parseBounded('[1,]',limits),SyntaxError);
  assert.deepEqual(candidate.parseBounded('[0]',limits),[0]);
});
