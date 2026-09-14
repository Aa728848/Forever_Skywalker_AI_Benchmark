import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeRecords,InvalidLineError} from '../starter/src/summary.ts';
test('hidden/prototype-keys-are-data',()=>{
 const result=summarizeRecords(['__proto__=9','constructor=2','toString=-3','__proto__=-4','hasOwnProperty=7']);
 assert.equal(Object.getPrototypeOf(result),Object.prototype);assert.equal(Object.hasOwn(result,'__proto__'),true);assert.equal(result.__proto__,5);assert.equal(result.constructor,2);assert.equal(result.toString,-3);assert.equal(result.hasOwnProperty,7);
});
test('hidden/seeded-independent-totals-and-invalid-index',()=>{
 for(let seed=1;seed<=25;seed++){const sums=new Map();const lines=[];for(let i=0;i<150;i++){const key='bucket'+((i*seed)%17);const n=(i*31+seed)%101-50;lines.push(key+'='+n);sums.set(key,(sums.get(key)??0)+n);}assert.deepEqual(summarizeRecords(lines),Object.fromEntries(sums));const bad=lines.slice();bad[seed]='broken=1.0';assert.throws(()=>summarizeRecords(bad),e=>e instanceof InvalidLineError&&e.index===seed);}
});
