import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenSession, SignedOutError } from '../starter/src/token-session.ts';
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes,no) => { resolve=yes; reject=no; }); return {promise,resolve,reject}; }
test('hidden/coalesces-rejection-without-auto-retry', async () => {
  const response=deferred<{accessToken:string}>();const fault=new Error('unauthorized');let calls=0;
  const session=new TokenSession({accessToken:'old',refreshToken:'refresh'},()=>{calls++;return response.promise});
  const first=session.refresh(),second=session.refresh();const finished=Promise.allSettled([first,second]);response.reject(fault);
  for(const result of await finished){assert.equal(result.status,'rejected');if(result.status==='rejected')assert.equal(result.reason,fault);}
  assert.equal(calls,1);assert.equal(session.current?.accessToken,'old');
});
test('hidden/late-success-cannot-restore-credentials', async () => {
  const response=deferred<{accessToken:string;refreshToken:string}>();let calls=0;
  const session=new TokenSession({accessToken:'old',refreshToken:'refresh'},()=>{calls++;return response.promise});
  const pending=session.refresh();const ended=Promise.allSettled([pending]);await Promise.resolve();session.logout();session.logout();
  response.resolve({accessToken:'late',refreshToken:'rotated'});const result=(await ended)[0];assert.equal(result?.status,'rejected');
  if(result?.status==='rejected')assert.ok(result.reason instanceof SignedOutError);
  assert.equal(session.current,null);await assert.rejects(session.refresh(),SignedOutError);assert.equal(calls,1);
});
test('hidden/failed-refresh-can-be-explicitly-retried', async () => {
  let calls=0;const failure=new Error('temporary');
  const session=new TokenSession({accessToken:'old',refreshToken:'keep'},async()=>{if(++calls===1)throw failure;return {accessToken:'new'};});
  await assert.rejects(session.refresh(),error=>error===failure);assert.equal(calls,1);assert.equal(session.current?.refreshToken,'keep');
  assert.deepEqual(await session.refresh(),{accessToken:'new',refreshToken:'keep'});assert.equal(calls,2);
});
