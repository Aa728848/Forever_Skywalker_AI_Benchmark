import test from 'node:test';
import assert from 'node:assert/strict';
import * as candidate from '../starter/src/persistent-cache.ts';
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const scope={workspace:'w',model:'m',rules:'1'};
function memory(text=null){let reads=0;let fail=false;return {get reads(){return reads;},get text(){return text;},fail(){fail=true;},storage:{async read(){reads++;return text;},async writeAtomic(value){if(fail){fail=false;throw new Error('disk full');}text=value;}}};}

test('hidden/boundary-corruption-vs-permission', async () => {
  for(const bad of ['{broken','{"schema":2,"entries":[]}','{"schema":1,"entries":[1]}'])assert.equal(await new candidate.PersistentCache(memory(bad).storage,scope).get('x'),undefined);
  let calls=0;const cache=new candidate.PersistentCache({async read(){if(++calls===1)throw new Error('EACCES');return null;},async writeAtomic(){}},scope);await assert.rejects(cache.get('x'),/EACCES/);assert.equal(await cache.get('x'),undefined);assert.equal(calls,2);
});

test('hidden/state-serial-writes', async () => {
  const gate=deferred();const disk=memory();let writes=0;const storage={...disk.storage,async writeAtomic(text){if(++writes===1)await gate.promise;await disk.storage.writeAtomic(text);}};const cache=new candidate.PersistentCache(storage,scope);const first=cache.set('a','1');const second=cache.set('b','2');await new Promise(resolve=>setImmediate(resolve));assert.equal(writes,1);gate.resolve();await Promise.all([first,second]);const restart=new candidate.PersistentCache(disk.storage,scope);assert.equal(await restart.get('a'),'1');assert.equal(await restart.get('b'),'2');
});

test('hidden/resource-real-file-restart', async () => {
  const {mkdtemp,writeFile,readFile,rename,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const directory=await mkdtemp(join(tmpdir(),'fsa-cache04-'));const path=join(directory,'cache.json');try{let reads=0;const storage={async read(){reads++;try{return await readFile(path,'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}},async writeAtomic(text){await writeFile(path+'.tmp',text);await rename(path+'.tmp',path);}};const first=new candidate.PersistentCache(storage,scope);await Promise.all(Array.from({length:30},()=>first.get('seed')));assert.equal(reads,1);await first.set('😀','value');assert.equal(await new candidate.PersistentCache(storage,scope).get('😀'),'value');assert.equal(await new candidate.PersistentCache(storage,{...scope,rules:'2'}).get('😀'),undefined);}finally{await rm(directory,{recursive:true,force:true});}
});
