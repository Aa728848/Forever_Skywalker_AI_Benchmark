import test from 'node:test';
import assert from 'node:assert/strict';

import {ProviderRegistry,type LoadableProvider} from '../starter/src/provider-registry.ts';

test('hidden/shared-load-coalesces-across-runtimes',async()=>{let calls=0;const gate=Promise.withResolvers<object>();const provider:LoadableProvider={id:'shared',runtime:'shared',label:'S',load(){calls++;return gate.promise;}};const registry=new ProviderRegistry([provider]);const first=registry.load('shared','node'),second=registry.load('shared','browser');await Promise.resolve();const before=calls;const value={token:'same'};gate.resolve(value);assert.equal(await first,value);assert.equal(await second,value);assert.equal(before,1);assert.equal(await registry.load('shared','node'),value);assert.equal(calls,1);await new ProviderRegistry([provider]).load('shared','node');assert.equal(calls,2);});

test('hidden/rejected-and-sync-throwing-loads-are-retryable',async()=>{for(const synchronous of [true,false]){const error=new Error('loader failed');let count=0;const registry=new ProviderRegistry([{id:'provider',runtime:'node',label:'N',load(){if(count++===0){if(synchronous)throw error;return Promise.reject(error);}return Promise.resolve('ready');}}]);let result:Promise<unknown>|undefined;assert.doesNotThrow(()=>{result=registry.load('provider','node');});await assert.rejects(result!,e=>e===error);assert.equal(await registry.load('provider','node'),'ready');assert.equal(count,2);}});

test('hidden/unavailable-identity-does-not-leak-cached-module',async()=>{const registry=new ProviderRegistry([{id:'node',runtime:'node',label:'N',async load(){return 'native';}}]);await registry.load('node','node');await assert.rejects(registry.load('node','browser'),RangeError);let unknown:Promise<unknown>|undefined;assert.doesNotThrow(()=>{unknown=registry.load('missing','node');});await assert.rejects(unknown!,RangeError);});
