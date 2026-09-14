import test from 'node:test';
import assert from 'node:assert/strict';

import { TransactionalLedger, TransactionConflictError, JournalCorruptError } from '../starter/src/transactional-ledger.ts';
const memory=()=>{const entries:string[]=[];return {entries,append:(entry:string)=>{entries.push(entry);},read:()=>[...entries]};};

test('hidden/safe-integer-transaction-validates-before-write',()=>{const journal=memory();const ledger=new TransactionalLedger(journal);for(const amounts of [[1.5],[NaN],[Infinity],[Number.MAX_SAFE_INTEGER,1]])assert.throws(()=>ledger.commit('invalid',amounts),RangeError);assert.throws(()=>ledger.commit('  ',[1]),RangeError);assert.equal(journal.entries.length,0);ledger.commit('edge',[Number.MAX_SAFE_INTEGER]);assert.throws(()=>ledger.commit('overflow',[1]),RangeError);assert.equal(journal.entries.length,1);});

test('hidden/confirmed-prefix-is-append-only',()=>{const journal=memory();const ledger=new TransactionalLedger(journal);ledger.commit('a',[4]);const original=journal.entries[0]!;journal.entries[0]=JSON.stringify({version:1,id:'a',amounts:[40]});assert.throws(()=>ledger.recover(),JournalCorruptError);assert.equal(ledger.balance,4);journal.entries.length=0;assert.throws(()=>ledger.recover(),JournalCorruptError);journal.entries.push(original);assert.equal(ledger.recover(),4);});

test('hidden/journal-rejection-without-write-retains-error-and-state',()=>{const journal=memory();const failure=new Error('write rejected');let broken=true;const ledger=new TransactionalLedger({read:journal.read,append(line){if(broken)throw failure;journal.append(line);}});assert.throws(()=>ledger.commit('a',[5]),error=>error===failure);assert.equal(ledger.balance,0);assert.equal(ledger.checkpoint,0);broken=false;assert.equal(ledger.commit('a',[5]).balance,5);});

import { mkdtempSync, rmSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';import { join } from 'node:path';import { spawnSync } from 'node:child_process';
test('hidden/process-exit-after-journal-append-is-idempotent',()=>{
  const directory=mkdtempSync(join(tmpdir(),'state-03-process-'));const file=join(directory,'journal.jsonl');
  try {const script=`import {appendFileSync,readFileSync,existsSync} from 'node:fs';const {TransactionalLedger}=await import(${JSON.stringify(new URL('../starter/src/transactional-ledger.ts',import.meta.url).href)});const file=${JSON.stringify(file)};const ledger=new TransactionalLedger({read:()=>existsSync(file)?readFileSync(file,'utf8').trim().split('\\n'):[],append:line=>{appendFileSync(file,line+'\\n',{flush:true});process.exit(29);}});ledger.commit('order',[18,-3]);`;
    const child=spawnSync(process.execPath,['--input-type=module','-e',script],{timeout:10000,encoding:'utf8',windowsHide:true});assert.equal(child.status,29,child.stderr);
    const journal={read:()=>existsSync(file)?readFileSync(file,'utf8').trim().split('\n'):[],append:(line:string)=>appendFileSync(file,line+'\n',{flush:true})};const ledger=new TransactionalLedger(journal);assert.equal(ledger.balance,15);assert.equal(ledger.commit('order',[18,-3]).balance,15);assert.equal(journal.read().length,1);
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test('hidden/seeded-replay-matches-independent-balance',()=>{const journal=memory();let ledger=new TransactionalLedger(journal),balance=0,state=71;for(let i=0;i<80;i++){state=(Math.imul(state,1664525)+1013904223)>>>0;const amounts=[state%100-50,(state>>>8)%50-25];balance+=amounts[0]!+amounts[1]!;const receipt=ledger.commit(String(i),amounts);assert.equal(receipt.balance,balance);assert.deepEqual(ledger.commit(String(i),amounts),receipt);if(i%7===0)ledger=new TransactionalLedger(journal);assert.equal(ledger.recover(),balance);}assert.equal(journal.entries.length,80);});
