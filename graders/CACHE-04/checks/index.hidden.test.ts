import test from 'node:test';
import assert from 'node:assert/strict';
import {PersistentCache,StaleWriteError} from '../starter/src/persistent-cache.ts';
const scope={workspace:'w',model:'m',rules:'r'};
function versioned(initial=null){
 let text=initial;
 const digest=()=>text===null?0:text.split('').reduce((hash,_,index)=>{hash^=text.charCodeAt(index);return Math.imul(hash,0x01000193)>>>0;},0x811c9dc5)>>>0;
 return {async read(){return text;},async writeAtomic(v){text=v;},async readVersioned(){return {text,epoch:digest()};},async writeAtomicIfUnchanged(v,expected){if(digest()!==expected)throw new StaleWriteError(expected);text=v;}};
}
const keyOf=(key)=>JSON.stringify(['w','m','r',key]);

test('hidden/index-stays-consistent-with-entries',async()=>{
 const storage=versioned();
 const cache=new PersistentCache(storage,scope);
 await cache.set('a','x');await cache.set('b','x');await cache.set('c','y');
 assert.deepEqual(cache.keysFor('x'),[keyOf('a'),keyOf('b')].sort());
 assert.deepEqual(cache.keysFor('y'),[keyOf('c')]);
 assert.deepEqual(cache.keysFor('missing'),[]);
 // 索引必须与条目同源：重启后从同一条目重建，结果必须完全一致。
 const restarted=new PersistentCache(storage,scope);
 await restarted.get('a');
 assert.deepEqual(restarted.keysFor('x'),[keyOf('a'),keyOf('b')].sort());
});

test('hidden/index-reflects-removal-and-overwrite',async()=>{
 const storage=versioned();
 const cache=new PersistentCache(storage,scope);
 await cache.set('a','x');
 assert.deepEqual(cache.keysFor('x'),[keyOf('a')]);
 await cache.set('a','y');
 assert.deepEqual(cache.keysFor('x'),[],'改写后旧值不得再命中');
 assert.deepEqual(cache.keysFor('y'),[keyOf('a')]);
 // 批次改写：同一批里既换值又新增，索引必须整体一致。
 await cache.setMany([['a','z'],['b','z']]);
 assert.deepEqual(cache.keysFor('y'),[],'批次改写后旧值不得再命中');
 assert.deepEqual(cache.keysFor('z'),[keyOf('a'),keyOf('b')].sort());
});

test('hidden/index-never-diverges-after-rejected-write',async()=>{
 const storage=versioned();
 const writer=new PersistentCache(storage,scope);
 const stale=new PersistentCache(storage,scope);
 await writer.set('k','first');
 await stale.get('k');
 await writer.set('k','winner');
 await assert.rejects(stale.set('k','loser'),StaleWriteError);
 // 被拒之后 stale 已重装最新状态：条目与索引都必须是 winner，不能残留 loser。
 assert.equal(await stale.get('k'),'winner');
 assert.deepEqual(stale.keysFor('loser'),[],'被拒的写入不得进入索引');
 assert.deepEqual(stale.keysFor('winner'),[keyOf('k')]);
});

test('hidden/index-survives-crash-recovery-replay',async()=>{
 const storage=versioned();
 const before=new PersistentCache(storage,scope);
 await before.set('kept','v');
 // 崩溃后重启：先读回落盘条目，再重放日志里已确认但未合并的条目。
 const restarted=new PersistentCache(storage,scope);
 await restarted.recover([['recovered','v']]);
 assert.deepEqual(restarted.keysFor('v'),[keyOf('kept'),keyOf('recovered')].sort(),'重放条目必须进入索引');
 assert.equal(await restarted.get('recovered'),'v');
});
