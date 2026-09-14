import test from 'node:test';
import assert from 'node:assert/strict';

import {SnapshotBatch,SnapshotBatchError} from '../starter/src/snapshot-batch.ts';
import {UnknownStateError} from '../starter/src/snapshot.ts';

test('hidden/mixed-version-batch-preserves-order-and-is-idempotent',()=>{const batch=new SnapshotBatch();const current=batch.replace([{key:'constructor',value:{version:1,status:'done'}},{key:'1',value:{version:2,state:'paid'}},{key:'__proto__',value:{version:1,status:'new'}}]);assert.deepEqual(current,[{key:'constructor',value:{version:2,state:'shipped'}},{key:'1',value:{version:2,state:'paid'}},{key:'__proto__',value:{version:2,state:'draft'}}]);assert.deepEqual(batch.replace(current),current);});

test('hidden/batch-input-and-output-do-not-alias-state',()=>{const batch=new SnapshotBatch();const input=[{key:'a',value:{version:2,state:'paid'}}];const output=batch.replace(input) as Array<{key:string;value:{version:number;state:string}}>;input[0]!.value.state='cancelled';output[0]!.value.state='draft';output.push({key:'x',value:{version:2,state:'paid'}});assert.deepEqual(batch.items,[{key:'a',value:{version:2,state:'paid'}}]);assert.deepEqual(batch.replace([]),[]);});
