import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenSession, SignedOutError } from '../starter/src/token-session.ts';
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes,no) => { resolve=yes; reject=no; }); return {promise,resolve,reject}; }
test('public/coalesces-token-refresh', async () => {
  const response=deferred<{accessToken:string}>(); let calls=0;
  const session=new TokenSession({accessToken:'old',refreshToken:'refresh'},()=>{calls++;return response.promise});
  const first=session.refresh(),second=session.refresh();
  response.resolve({accessToken:'new'}); const values=await Promise.all([first,second]);
  assert.equal(calls,1); assert.deepEqual(values,[{accessToken:'new',refreshToken:'refresh'},{accessToken:'new',refreshToken:'refresh'}]);
});
test('public/logout-invalidates-inflight-refresh', async () => {
  const response=deferred<{accessToken:string}>();
  const session=new TokenSession({accessToken:'old',refreshToken:'refresh'},()=>response.promise);
  const pending=session.refresh(); const rejected=assert.rejects(pending,SignedOutError);
  session.logout();response.resolve({accessToken:'late'});await rejected;
  assert.equal(session.current,null);await assert.rejects(session.refresh(),SignedOutError);
});
test('public/refresh-preserves-unrotated-token', async () => {
  const received:string[]=[];let count=0;
  const session=new TokenSession({accessToken:'old',refreshToken:'first'},async token=>{received.push(token);return ++count===1?{accessToken:'one',refreshToken:'second'}:{accessToken:'two'};});
  await session.refresh();await session.refresh();
  assert.deepEqual(received,['first','second']);assert.deepEqual(session.current,{accessToken:'two',refreshToken:'second'});
});
