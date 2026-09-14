import test from 'node:test';
import assert from 'node:assert/strict';

import {SnapshotBatch,SnapshotBatchError} from '../starter/src/snapshot-batch.ts';
import {UnknownStateError} from '../starter/src/snapshot.ts';

test('public/batch-failure-preserves-confirmed-snapshot',()=>{const batch=new SnapshotBatch();batch.replace([{key:'confirmed',value:{version:2,state:'paid'}}]);const before=batch.items;assert.throws(()=>batch.replace([{key:'new',value:{version:2,state:'draft'}},{key:'bad',value:{version:1,status:'unknown'}}]),error=>error instanceof SnapshotBatchError&&error.index===1&&error.key==='bad'&&error.cause instanceof UnknownStateError);assert.deepEqual(batch.items,before);});

test('public/duplicate-key-is-atomic-domain-error',()=>{const batch=new SnapshotBatch();batch.replace([{key:'kept',value:{version:2,state:'shipped'}}]);assert.throws(()=>batch.replace([{key:'__proto__',value:{version:2,state:'paid'}},{key:'__proto__',value:{version:2,state:'cancelled'}}]),error=>error instanceof SnapshotBatchError&&error.index===1&&error.cause instanceof RangeError);assert.equal(batch.items[0]!.key,'kept');});
