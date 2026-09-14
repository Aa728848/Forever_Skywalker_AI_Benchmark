import test from 'node:test';
import assert from 'node:assert/strict';
import {VersionedCache} from '../starter/src/cache.ts';
test('public/many-preserves-order-and-coalesces',async()=>{const calls:string[]=[];const cache=new VersionedCache({async load(key){calls.push(key);return key+':value';}});const result=await cache.getMany(['b','a','b']);assert.deepEqual(result,['b:value','a:value','b:value']);assert.deepEqual(calls,['b','a']);assert.equal(Object.isFrozen(result),true);});
