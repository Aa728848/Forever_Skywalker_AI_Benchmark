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

test('hidden/state-retry-after-create-failure',async()=>{
fixture(({path,ledger,restart})=>{const open=fs.openSync;fs.openSync=(target,...args)=>{if(target===path+'.tmp')throw new Error('injected disk failure');return open(target,...args);};syncBuiltinESMExports();try{assert.throws(()=>ledger.apply(create()),/disk failure/);}finally{fs.openSync=open;syncBuiltinESMExports();}assert.equal(ledger.snapshot().tasks.length,0);ledger.apply(create());const next=restart();next.apply(create());assert.equal(next.snapshot().tasks.length,1);});
});

test('hidden/regression-startup-reconciliation',async()=>{
fixture(({ledger,restart})=>{ledger.apply(create('one'));ledger.apply({requestId:'create-two',action:{kind:'create',id:'two',input:{title:'two',prompt:''}}});const lost=ledger.openRun('one','manual');const durable=ledger.openRun('two','manual');ledger.attachSession('two',durable.executionId,'session-confirmed');const next=restart();next.reconcileStartup();const tasks=next.snapshot().tasks;assert.equal(tasks.find(t=>t.id==='one').executions.find(e=>e.id===lost.executionId).result,'cancelled');assert.equal(tasks.find(t=>t.id==='two').executions[0].endedAt,undefined);});
});

test('hidden/resources-lock-and-history-bound',async()=>{
fixture(({path,ledger})=>{assert.throws(()=>new TasksLedger(path),LedgerLockedError);ledger.apply(create());for(let i=0;i<70;i++){const run=ledger.openRun('quote-task','manual');ledger.settleRun('quote-task',run.executionId,'succeeded',undefined);}assert.ok(ledger.snapshot().tasks[0].executions.length<=protocol.EXECUTION_HISTORY_LIMIT);for(let i=0;i<270;i++)ledger.apply({requestId:'u'+i,action:{kind:'update',taskId:'quote-task',patch:{title:'value'+i}}});assert.ok(JSON.parse(fs.readFileSync(path,'utf8')).recentRequests.length<=256);});
});
