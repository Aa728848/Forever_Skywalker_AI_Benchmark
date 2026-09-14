import test from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRecordStore, CorruptRecordError } from '../starter/src/store.ts';
test('hidden/invalid-json-shapes-use-domain-error',()=>{
  const directory=mkdtempSync(join(tmpdir(),'state-01-shapes-'));const store=openRecordStore(directory);
  try {for(const raw of ['null','[]','42','true','"text"','{}','{"value":null,"checksum":"x"}']){
    writeFileSync(join(directory,'record.rec'),raw);
    assert.throws(()=>store.read('record'),error=>error instanceof CorruptRecordError&&error.key==='record',raw);
  }} finally {store.close();rmSync(directory,{recursive:true,force:true});}
});

test('hidden/rename-failure-preserves-record-and-cleans-staging',()=>{
  const directory=mkdtempSync(join(tmpdir(),'state-01-rename-'));const store=openRecordStore(directory);
  const original=fs.renameSync;const failure=new Error('injected rename failure');let attempts=0;
  try {
    store.write('record','confirmed');
    fs.renameSync=((...args:Parameters<typeof fs.renameSync>)=>{if(String(args[1])===join(directory,'record.rec')){attempts++;throw failure;}return original(...args);}) as typeof fs.renameSync;
    syncBuiltinESMExports();assert.throws(()=>store.write('record','replacement'),error=>error===failure);
    assert.equal(attempts,1);assert.equal(store.read('record'),'confirmed');assert.deepEqual(readdirSync(directory),['record.rec']);
  } finally {fs.renameSync=original;syncBuiltinESMExports();store.close();rmSync(directory,{recursive:true,force:true});}
});
