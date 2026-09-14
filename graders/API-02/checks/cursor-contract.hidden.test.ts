import test from 'node:test';
import assert from 'node:assert/strict';
import {PageError,encodeCursor,decodeCursor,paginate} from '../starter/src/page.ts';
test('hidden/canonical-bytes-and-safe-offsets',()=>{
 const invalid=(fn)=>assert.throws(fn,e=>e instanceof PageError&&e.field==='cursor');
 for(const n of [-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])invalid(()=>encodeCursor(n));
 for(const raw of ['offset:9007199254740992','offset:+1','offset:01','offset:1.0','offset:1\n'])invalid(()=>decodeCursor(Buffer.from(raw).toString('base64url')));
 const canonical=Buffer.from('offset:17').toString('base64url');for(const raw of [canonical+'=',canonical+'\n',' '+canonical])invalid(()=>decodeCursor(raw));
 for(const n of [0,1,127,65535,Number.MAX_SAFE_INTEGER])assert.equal(decodeCursor(encodeCursor(n)),n);
});
test('hidden/independent-pagination-partitions',()=>{
 for(let seed=1;seed<=31;seed++){
  const input=Array.from({length:seed*7},(_,i)=>({id:seed+':'+i}));const original=[...input];let cursor=null;const output=[];const limit=seed%11+1;
  do{const page=paginate(input,{cursor,limit});output.push(...page.items);cursor=page.nextCursor;}while(cursor!==null);
  assert.deepEqual(output,original);assert.deepEqual(input,original);assert.equal(new Set(output).size,input.length);
 }
});
