import test from 'node:test';
import assert from 'node:assert/strict';
import { ByteSseStream, BackpressureError } from '../starter/src/byte-stream.ts';
const encoder = new TextEncoder();
const frame=(id:number,data:string)=>encoder.encode('id: '+id+'\ndata: '+data+'\n\n');
test('public/utf8-split-at-every-byte',()=>{const stream=new ByteSseStream({capacity:2,maxBufferedBytes:1024,fromId:0});for(const byte of frame(1,'中文🚀'))stream.push(Uint8Array.of(byte));stream.end();assert.deepEqual(stream.drain(1),[{id:1,data:'中文🚀'}]);});
test('public/slow-consumer-queue-is-bounded',()=>{const stream=new ByteSseStream({capacity:1,maxBufferedBytes:1024,fromId:0});stream.push(frame(1,'a'));assert.throws(()=>stream.push(frame(2,'b')),BackpressureError);assert.equal(stream.queued,1);assert.throws(()=>stream.drain(1),BackpressureError);});
test('public/reconnect-uses-delivered-cursor',()=>{const original=new ByteSseStream({capacity:3,maxBufferedBytes:1024,fromId:0});original.push(frame(1,'a'));original.push(frame(2,'b'));assert.equal(original.lastId,0);assert.deepEqual(original.drain(1),[{id:1,data:'a'}]);const resumed=new ByteSseStream({capacity:3,maxBufferedBytes:1024,fromId:original.lastId});resumed.push(frame(1,'a'));resumed.push(frame(2,'b'));resumed.push(frame(3,'c'));assert.deepEqual(resumed.drain(10),[{id:2,data:'b'},{id:3,data:'c'}]);assert.equal(resumed.lastId,3);});
