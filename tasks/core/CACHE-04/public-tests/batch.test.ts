import test from 'node:test';
import assert from 'node:assert/strict';
import {PersistentCache} from '../starter/src/persistent-cache.ts';
test('public/batch-is-one-atomic-write',async()=>{let text:string|null=null;let writes=0;const cache=new PersistentCache({async read(){return text;},async writeAtomic(value){writes++;text=value;}},{workspace:'w',model:'m',rules:'r'});await cache.setMany([['a','1'],['b','2']]);assert.equal(writes,1);assert.deepEqual(await cache.snapshot(['b','a']),[{key:'b',value:'2'},{key:'a',value:'1'}]);});
