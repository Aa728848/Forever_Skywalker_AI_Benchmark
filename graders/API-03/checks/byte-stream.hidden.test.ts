import test from 'node:test';
import assert from 'node:assert/strict';
import { ByteSseStream, BackpressureError } from '../starter/src/byte-stream.ts';
import { SequenceGapError } from '../starter/src/sse.ts';
const encoder = new TextEncoder();
const frame=(id:number,data:string)=>encoder.encode('id: '+id+'\ndata: '+data+'\n\n');
test('hidden/every-utf8-split-position-preserves-data',()=>{const bytes=frame(1,'é汉字🎯');for(let at=1;at<bytes.length;at++){const stream=new ByteSseStream({capacity:1,maxBufferedBytes:1024,fromId:0});stream.push(bytes.subarray(0,at));stream.push(bytes.subarray(at));assert.deepEqual(stream.drain(1),[{id:1,data:'é汉字🎯'}]);}});
test('hidden/incomplete-frame-budget-is-enforced',()=>{const stream=new ByteSseStream({capacity:2,maxBufferedBytes:16,fromId:0});stream.push(encoder.encode('id: 1\ndata: '));assert.throws(()=>stream.push(encoder.encode('123456789')),BackpressureError);assert.throws(()=>stream.push(frame(1,'x')),BackpressureError);});
test('hidden/draining-permits-progress-without-duplicate-delivery',()=>{const stream=new ByteSseStream({capacity:1,maxBufferedBytes:1024,fromId:40});stream.push(frame(41,'a'));assert.equal(stream.drain(1)[0]?.id,41);stream.push(frame(41,'duplicate'));assert.equal(stream.queued,0);stream.push(frame(42,'b'));assert.equal(stream.drain(1)[0]?.id,42);assert.throws(()=>stream.push(frame(44,'gap')),SequenceGapError);assert.equal(stream.lastId,42);});
