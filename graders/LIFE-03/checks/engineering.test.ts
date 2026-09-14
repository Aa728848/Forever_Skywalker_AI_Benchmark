import test from 'node:test';
import assert from 'node:assert/strict';

import {Supervisor} from '../starter/src/supervisor.ts';
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};

test('hidden/concurrent-restarts-join-one-stopping-generation',async()=>{const gates=[Promise.withResolvers<void>(),Promise.withResolvers<void>()];const signals:AbortSignal[]=[];const supervisor=new Supervisor({run(signal){signals.push(signal);return gates[Math.min(signals.length-1,1)]!.promise;}});await supervisor.start();const stopping=supervisor.stop();await flush();const pending=Array.from({length:12},()=>supervisor.start());await flush();const before=signals.length;gates[0]!.resolve();await Promise.all([stopping,...pending]);const after=signals.length;const fresh=signals[1]?.aborted;gates[1]!.resolve();await supervisor.stop();assert.equal(before,1);assert.equal(after,2);assert.equal(fresh,false);});

test('hidden/async-runner-rejection-releases-resources',async()=>{const first=Promise.withResolvers<void>();const second=Promise.withResolvers<void>();let calls=0;const supervisor=new Supervisor({run(){return calls++===0?first.promise:second.promise;}});await supervisor.start();first.reject(new Error('runtime failed'));await flush();assert.equal(supervisor.phase,'idle');await supervisor.start();assert.equal(calls,2);second.resolve();await supervisor.stop();});

test('hidden/seeded-natural-and-controlled-stops-remain-independent',async()=>{const signals:AbortSignal[]=[];let gate=Promise.withResolvers<void>();const supervisor=new Supervisor({run(signal){signals.push(signal);signal.addEventListener('abort',()=>gate.resolve(),{once:true});return gate.promise;}});for(let i=0;i<30;i++){gate=Promise.withResolvers<void>();await supervisor.start();assert.equal(supervisor.phase,'running');assert.equal(signals.at(-1)!.aborted,false);if(i%3===1){gate.resolve();await flush();}else await supervisor.stop();assert.equal(supervisor.phase,'idle');}assert.equal(new Set(signals).size,30);assert.equal(supervisor.startCount,30);});
