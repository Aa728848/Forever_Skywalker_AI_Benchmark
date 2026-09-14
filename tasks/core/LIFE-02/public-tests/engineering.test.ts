import test from 'node:test';
import assert from 'node:assert/strict';

import {StreamSession} from '../starter/src/stream-session.ts';

test('public/synchronous-end-releases-late-subscription-handle',()=>{let released=0,cancelled=0;const session=new StreamSession({subscribe(push){push({kind:'data',value:5});push({kind:'end'});return ()=>{released++;};}},{after(_ms,_run){return ()=>{cancelled++;};}});assert.deepEqual(session.summary,{total:5,count:1,ended:true,error:null});assert.equal(released,1);assert.equal(cancelled,1);session.cancel();assert.equal(released,1);});
