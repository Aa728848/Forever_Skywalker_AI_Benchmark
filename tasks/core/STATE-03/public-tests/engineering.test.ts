import test from 'node:test';
import assert from 'node:assert/strict';

import { TransactionalLedger, TransactionConflictError, JournalCorruptError } from '../starter/src/transactional-ledger.ts';
const memory=()=>{const entries:string[]=[];return {entries,append:(entry:string)=>{entries.push(entry);},read:()=>[...entries]};};

test('public/transaction-identity-preserves-original-receipt',()=>{const journal=memory();const ledger=new TransactionalLedger(journal);const first=ledger.commit('__proto__',[10,-2]);ledger.commit('next',[5]);assert.deepEqual(ledger.commit('__proto__',[10,-2]),first);assert.throws(()=>ledger.commit('__proto__',[10,-3]),TransactionConflictError);assert.equal(journal.entries.length,2);assert.equal(ledger.balance,13);});

test('public/acknowledgement-loss-reconciles-persisted-transaction',()=>{const journal=memory();const failure=new Error('ack lost');let first=true;const ledger=new TransactionalLedger({read:journal.read,append(line){journal.append(line);if(first){first=false;throw failure;}}});assert.deepEqual(ledger.commit('payment',[7,9]),{id:'payment',balance:16,checkpoint:1});assert.equal(ledger.commit('payment',[7,9]).balance,16);assert.equal(journal.entries.length,1);});

test('public/recovery-publishes-only-completely-valid-snapshot',()=>{const journal=memory();const ledger=new TransactionalLedger(journal);ledger.commit('a',[10]);journal.append(JSON.stringify({version:1,id:'b',amounts:[20]}));journal.append('{broken');assert.throws(()=>ledger.recover(),JournalCorruptError);assert.equal(ledger.balance,10);assert.equal(ledger.checkpoint,1);journal.entries.pop();assert.equal(ledger.recover(),30);assert.equal(ledger.recover(),30);assert.equal(ledger.checkpoint,2);});
