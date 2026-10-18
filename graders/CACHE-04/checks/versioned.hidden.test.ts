import test from 'node:test';
import assert from 'node:assert/strict';
import {PersistentCache,StaleWriteError} from '../starter/src/persistent-cache.ts';
const scope={workspace:'w',model:'m',rules:'r'};
/** 带 epoch 的内存存储：与真实文件存储同语义，便于构造交错。 */
function versioned(initial=null){
 let text=initial;
 const epoch=()=>text===null?0:text.split('').reduce((hash,_,index)=>{hash^=text.charCodeAt(index);return Math.imul(hash,0x01000193)>>>0;},0x811c9dc5)>>>0;
 return {
  async read(){return text;},
  async writeAtomic(value){text=value;},
  async readVersioned(){return {text,epoch:epoch()};},
  async writeAtomicIfUnchanged(value,expected){const current=epoch();assert.equal(typeof expected,'number');if(current!==expected)throw new StaleWriteError(expected);text=value;}
 };
}

test('hidden/stale-instance-write-is-rejected',async()=>{
 const storage=versioned();
 const stale=new PersistentCache(storage,scope);
 const fresh=new PersistentCache(storage,scope);
 await stale.set('k','first');
 await fresh.get('k');
 await fresh.set('k','winner');
 await assert.rejects(stale.set('k','loser'),StaleWriteError);
 // 被拒的写入不得改变文件：读回来的仍是 winner。
 assert.equal(await new PersistentCache(storage,scope).get('k'),'winner');
});

test('hidden/rejected-instance-resyncs-then-wins',async()=>{
 const storage=versioned();
 const a=new PersistentCache(storage,scope);
 const b=new PersistentCache(storage,scope);
 await a.set('k','one');
 await b.get('k');
 await a.set('k','two');
 await assert.rejects(b.set('k','stale'),StaleWriteError);
 // 拒绝之后 b 必须已经重新装载到最新版本，因此紧接着的写入应当成功。
 await b.set('k','b-wins');
 assert.equal(await new PersistentCache(storage,scope).get('k'),'b-wins');
});

test('hidden/recovery-journal-replays-confirmed-entries',async()=>{
 const storage=versioned();
 await new PersistentCache(storage,scope).set('kept','persisted');
 const restarted=new PersistentCache(storage,scope);
 await restarted.recover([['recovered','value']]);
 assert.equal(await restarted.get('kept'),'persisted','已落盘条目仍须可读');
 assert.equal(await restarted.get('recovered'),'value','日志中的已确认条目必须重放进内存');
});

test('hidden/versioned-path-keeps-domain-isolation',async()=>{
 const storage=versioned();
 const one=new PersistentCache(storage,{workspace:'w1',model:'m',rules:'r'});
 const two=new PersistentCache(storage,{workspace:'w2',model:'m',rules:'r'});
 await one.set('k','one');
 await two.set('k','two');
 await one.refresh();
 await two.refresh();
 assert.equal(await one.get('k'),'one');
 assert.equal(await two.get('k'),'two');
 // 域隔离必须覆盖 model 与 rules：只按 workspace 组键会让后两者互相串味。
 const models=new PersistentCache(storage,{workspace:'w1',model:'m2',rules:'r'});
 const rules=new PersistentCache(storage,{workspace:'w1',model:'m',rules:'r2'});
 assert.equal(await models.get('k'),undefined,'不同 model 不得读到同一键');
 assert.equal(await rules.get('k'),undefined,'不同 rules 不得读到同一键');
 await models.set('k','m2-value');
 await one.refresh();
 assert.equal(await one.get('k'),'one','写入其它 model 不得覆盖本域确认值');
});
