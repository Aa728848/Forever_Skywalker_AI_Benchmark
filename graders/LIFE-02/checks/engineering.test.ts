import test from 'node:test';
import assert from 'node:assert/strict';

import {StreamSession} from '../starter/src/stream-session.ts';
import type {StreamEvent} from '../starter/src/stream.ts';

test('hidden/cancel-freezes-and-reclaims-both-resources',()=>{let emit!:(event:StreamEvent)=>void,timeout!:()=>void;let released=0,cancelled=0;const session=new StreamSession({subscribe(push){emit=push;return ()=>{released++;};}},{after(ms,run){assert.equal(ms,37);timeout=run;return ()=>{cancelled++;};}},37);emit({kind:'data',value:8});session.cancel();session.cancel();emit({kind:'data',value:100});timeout();assert.deepEqual(session.summary,{total:8,count:1,ended:false,error:'已取消'});assert.equal(released,1);assert.equal(cancelled,1);});

test('hidden/synchronous-deadline-does-not-open-source',()=>{let opened=0,cancelled=0;const session=new StreamSession({subscribe(){opened++;return ()=>{};}},{after(_ms,run){run();return ()=>{cancelled++;};}});assert.equal(opened,0);assert.equal(cancelled,1);assert.equal(session.summary.error,'超时');});

test('hidden/source-start-failure-releases-deadline',()=>{let cancelled=0;const failure=new Error('subscribe failed');assert.throws(()=>new StreamSession({subscribe(){throw failure;}},{after(){return ()=>{cancelled++;};}}),error=>error===failure);assert.equal(cancelled,1);});
