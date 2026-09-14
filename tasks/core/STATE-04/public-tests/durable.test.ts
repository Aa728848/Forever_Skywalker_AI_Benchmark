import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableCoordinator, DurableConflictError, type CrashPoint } from '../starter/src/durable-coordinator.ts';
function temporary(work:(directory:string)=>Promise<void>) { const directory=mkdtempSync(join(tmpdir(),'fsa-durable-state-'));return work(directory).finally(()=>rmSync(directory,{recursive:true,force:true})); }
test('public/restart-rebuilds-projections-after-commit',()=>temporary(async directory=>{const crash=new Error('crash');const first=new DurableCoordinator(directory,point=>{if(point==='after-commit')throw crash});await assert.rejects(first.commit('trade','one'),error=>error===crash);const next=new DurableCoordinator(directory);assert.deepEqual(next.snapshot(),{service:{revision:1,values:['one']},cache:{revision:1,values:['one']},ui:{revision:1,values:['one']}});assert.deepEqual(await next.commit('trade','one'),{revision:1,values:['one']});}));
test('public/stale-notification-cannot-roll-back-ui',()=>temporary(async directory=>{const state=new DurableCoordinator(directory);await state.commit('a','one');await state.commit('b','two');const before=state.snapshot();state.notify(1);state.notify(1);assert.deepEqual(state.snapshot(),before);await assert.rejects(state.commit('a','changed'),DurableConflictError);}));
test('public/precommit-failure-has-no-transaction',()=>temporary(async directory=>{const state=new DurableCoordinator(directory,(point:CrashPoint)=>{if(point==='before-commit')throw new Error('crash')});await assert.rejects(state.commit('a','one'));const next=new DurableCoordinator(directory);assert.deepEqual(next.snapshot().service,{revision:0,values:[]});assert.deepEqual(await next.commit('a','one'),{revision:1,values:['one']});}));
