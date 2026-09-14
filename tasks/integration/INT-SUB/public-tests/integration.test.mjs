import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks,stripTypeScriptTypes} from 'node:module';
import {readFileSync} from 'node:fs';
const ROOT=new URL('../starter/',import.meta.url);
const aliases={"@deepseek-ai/dsh-timeout":"vendor/deepseek-harness/packages/util/timeout/src/index.ts","@deepseek-ai/dsh-llm":"vendor/deepseek-harness/packages/llm/llm/src/index.ts"};
registerHooks({resolve(specifier,context,next){const path=aliases[specifier];return path?{url:new URL(path,ROOT).href,shortCircuit:true}:next(specifier,context);},load(url,context,next){if(url.startsWith(ROOT.href)&&url.endsWith('.ts'))return{format:'module',source:stripTypeScriptTypes(readFileSync(new URL(url),'utf8'),{mode:'transform'}),shortCircuit:true};return next(url,context);}});
// 定向加载冻结完整index.ts中的真实LlmError声明，避免初始化不相关的完整LLM运行时。
registerHooks({load(url,context,next){if(url===new URL('vendor/deepseek-harness/packages/llm/llm/src/index.ts',ROOT).href){const full=readFileSync(new URL(url),'utf8');const start=full.indexOf('/** Structured provider facts');const end=full.indexOf('/**\n * Accept one supplied credential',start);if(start<0||end<0)throw new Error('frozen LlmError declaration boundary missing');return {format:'module',source:stripTypeScriptTypes("import {HarnessError} from './error.ts';\n"+full.slice(start,end),{mode:'transform'}),shortCircuit:true};}return next(url,context);}});
const {OAuthService,OAuthServiceError}=await import(new URL('src/host/oauth-service.ts',ROOT));
const {MemoryTokenStore}=await import(new URL('src/host/token-store.ts',ROOT));
const {wrapStreamWithWatchdog}=await import(new URL('src/host/common/idle-watchdog.ts',ROOT));
const quiet={info(){},warn(){}};const initial={accessToken:'synthetic-old',refreshToken:'synthetic-refresh',expiresAt:0};
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const response=()=>new Response(JSON.stringify({access_token:'synthetic-new',expires_in:3600}),{status:200,headers:{'content-type':'application/json'}});

test('public/behavior-refresh-single-flight',async()=>{
const store=new MemoryTokenStore();await store.save(initial);const gate=deferred();let calls=0;const service=new OAuthService(store,{fetchFn:async()=>{calls++;return gate.promise;},now:()=>1000,logger:quiet});try{const work=[service.credentials(true),service.credentials(true)];await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);gate.resolve(response());const [a,b]=await Promise.all(work);assert.equal(a.accessToken,'synthetic-new');assert.equal(a.refreshToken,'synthetic-refresh');assert.deepEqual(a,b);assert.equal((await store.load()).accessToken,'synthetic-new');}finally{service.dispose();}
});

test('public/state-logout-blocks-late-refresh',async()=>{
const store=new MemoryTokenStore();await store.save(initial);const gate=deferred();const service=new OAuthService(store,{fetchFn:()=>gate.promise,now:()=>1000,logger:quiet});const work=service.credentials(true);await new Promise(resolve=>setImmediate(resolve));await service.logout();gate.resolve(response());try{await assert.rejects(work,error=>error instanceof OAuthServiceError&&error.code==='not-authenticated');assert.equal(await store.load(),null);}finally{service.dispose();}
});

test('public/resources-consumer-stop-aborts-source',async()=>{
let signal,returned=0;const source=upstream=>{signal=upstream;return {[Symbol.asyncIterator](){return {async next(){return {done:false,value:'chunk'};},async return(){returned++;return {done:true,value:undefined};}};}};};for await(const value of wrapStreamWithWatchdog(source,undefined,1000)){assert.equal(value,'chunk');break;}assert.equal(signal.aborted,true);assert.equal(returned,1);
});

test('public/boundary-pre-cancel-never-creates-source', async () => {
  const controller = new AbortController(); controller.abort();
  let created = 0;
  const stream = wrapStreamWithWatchdog(() => { created++; throw new Error('取消后不应创建传输'); }, controller.signal, 10);
  await assert.rejects(stream[Symbol.asyncIterator]().next(), error => error.code === 'ABORTED');
  assert.equal(created, 0);
});
