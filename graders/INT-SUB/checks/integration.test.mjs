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

test('hidden/state-save-in-flight-then-logout',async()=>{
const store=new MemoryTokenStore();await store.save(initial);const save=store.save.bind(store),started=deferred(),finish=deferred();store.save=async value=>{if(value.accessToken==='synthetic-new'){started.resolve();await finish.promise;}await save(value);};const service=new OAuthService(store,{fetchFn:async()=>response(),now:()=>1000,logger:quiet});const work=service.credentials(true);const rejected=work.then(()=>false,error=>error.code==='not-authenticated');await started.promise;const logout=service.logout();finish.resolve();await logout;assert.equal(await rejected,true);assert.equal(await store.load(),null);service.dispose();
});

test('hidden/boundary-disposed-and-caller-cancel',async()=>{
const store=new MemoryTokenStore();await store.save({...initial,expiresAt:999999});const service=new OAuthService(store,{now:()=>0,logger:quiet});service.dispose();await assert.rejects(service.credentials(),OAuthServiceError);const cancel=new AbortController();let returned=0;const iterable=wrapStreamWithWatchdog(signal=>({[Symbol.asyncIterator](){return {next(){return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('source cancelled')),{once:true}));},async return(){returned++;return {done:true,value:undefined};}};}}),cancel.signal,1000);const iterator=iterable[Symbol.asyncIterator]();const pending=iterator.next();cancel.abort();await assert.rejects(pending,error=>error.code==='ABORTED');assert.equal(returned,1);
});

test('hidden/regression-refresh-failure-retries',async()=>{
const store=new MemoryTokenStore();await store.save(initial);let calls=0;const service=new OAuthService(store,{fetchFn:async()=>{if(++calls===1)throw new Error('synthetic outage');return response();},now:()=>1000,logger:quiet});try{await assert.rejects(service.credentials(true),error=>error.code==='refresh-failed');assert.equal((await service.credentials(true)).accessToken,'synthetic-new');assert.equal(calls,2);}finally{service.dispose();}
});
