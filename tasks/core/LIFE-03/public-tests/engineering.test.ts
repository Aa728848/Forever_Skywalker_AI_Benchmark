import test from 'node:test';
import assert from 'node:assert/strict';

import {Supervisor} from '../starter/src/supervisor.ts';
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};

test('public/natural-completion-releases-generation',async()=>{const gates=[Promise.withResolvers<void>(),Promise.withResolvers<void>()];const signals:AbortSignal[]=[];const supervisor=new Supervisor({run(signal){signals.push(signal);return gates[signals.length-1]!.promise;}});await supervisor.start();gates[0]!.resolve();await flush();assert.equal(supervisor.phase,'idle');await supervisor.start();assert.equal(signals.length,2);assert.notEqual(signals[0],signals[1]);gates[1]!.resolve();await supervisor.stop();});

test('public/synchronous-runner-failure-is-retryable',async()=>{const failure=new Error('sync setup');let calls=0;const gate=Promise.withResolvers<void>();const supervisor=new Supervisor({run(){if(calls++===0)throw failure;return gate.promise;}});await assert.rejects(supervisor.start(),error=>error===failure);assert.equal(supervisor.phase,'idle');await supervisor.start();assert.equal(calls,2);assert.equal(supervisor.startCount,2);gate.resolve();await supervisor.stop();});
