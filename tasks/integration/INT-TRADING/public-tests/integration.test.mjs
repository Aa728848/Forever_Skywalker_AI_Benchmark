import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks,stripTypeScriptTypes} from 'node:module';
import {readFileSync} from 'node:fs';
const ROOT=new URL('../starter/',import.meta.url);
const aliases={};
registerHooks({resolve(specifier,context,next){const path=aliases[specifier];return path?{url:new URL(path,ROOT).href,shortCircuit:true}:next(specifier,context);},load(url,context,next){if(url.startsWith(ROOT.href)&&url.endsWith('.ts'))return{format:'module',source:stripTypeScriptTypes(readFileSync(new URL(url),'utf8'),{mode:'transform'}),shortCircuit:true};return next(url,context);}});
const {TasksLedger,TaskActionError,LedgerLockedError}=await import(new URL('packages/client-ui-trading/src/tasks/ledger.ts',ROOT));
const protocol=await import(new URL('packages/client-ui-trading/src/client/tasks-protocol.ts',ROOT));
const {TtlCache}=await import(new URL('packages/client-ui-trading/src/ttl-cache.ts',ROOT));
import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {tmpdir} from 'node:os';import {join} from 'node:path';
function fixture(work){const directory=fs.mkdtempSync(join(tmpdir(),'fsa-trading-'));const path=join(directory,'ledger.json');let ledger=new TasksLedger(path,{now:()=>1700000000000});try{return work({path,ledger,restart(){ledger.dispose();ledger=new TasksLedger(path,{now:()=>1700000001000});return ledger;}});}finally{ledger.dispose();fs.rmSync(directory,{recursive:true,force:true});}}
const create=(id='quote-task')=>({requestId:'quote-1',action:{kind:'create',id,input:{title:'synthetic quote',prompt:'paper only',schedule:{enabled:true,cron:'*/5 * * * *'}}}});

test('public/behavior-quote-cache-to-durable-task',async()=>{
fixture(({ledger,restart})=>{const prices=new TtlCache(100,2);prices.set('SYN',123,0);assert.equal(prices.getFresh('SYN',50),123);const envelope=protocol.parseTasksEnvelope(create());assert.ok(envelope);ledger.apply(envelope);assert.equal(prices.getFresh('SYN',100),undefined);const next=restart();assert.equal(next.snapshot().tasks[0].id,'quote-task');assert.ok(next.snapshot().tasks[0].schedule.nextRunAt>1700000000000);});
});

test('public/state-failed-write-is-not-visible',async()=>{
fixture(({path,ledger,restart})=>{ledger.apply(create());const before=ledger.snapshot();const text=fs.readFileSync(path,'utf8');let notifications=0;ledger.subscribe(()=>notifications++);const rename=fs.renameSync;fs.renameSync=(from,to)=>{if(to===path)throw Object.assign(new Error('injected EIO'),{code:'EIO'});return rename(from,to);};syncBuiltinESMExports();try{assert.throws(()=>ledger.apply({requestId:'update-1',action:{kind:'update',taskId:'quote-task',patch:{title:'unconfirmed'}}}),/EIO/);}finally{fs.renameSync=rename;syncBuiltinESMExports();}assert.deepEqual(ledger.snapshot(),before);assert.equal(fs.readFileSync(path,'utf8'),text);assert.equal(notifications,0);ledger.apply({requestId:'update-1',action:{kind:'update',taskId:'quote-task',patch:{title:'unconfirmed'}}});assert.equal(restart().snapshot().tasks[0].title,'unconfirmed');});
});

test('public/boundary-protocol-and-idempotent-conflict',async()=>{
fixture(({ledger})=>{assert.equal(protocol.parseTasksEnvelope({...create(),scheduler:{lastTickAt:1}}),undefined);ledger.apply(create());assert.throws(()=>ledger.apply({...create(),action:{kind:'delete',taskId:'quote-task'}}),error=>error instanceof TaskActionError&&error.code==='TASKS_REQUEST_CONFLICT');assert.equal(ledger.snapshot().tasks.length,1);});
});
