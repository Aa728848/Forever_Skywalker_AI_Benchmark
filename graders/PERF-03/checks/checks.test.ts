import test from 'node:test';
import assert from 'node:assert/strict';
import * as candidate from '../starter/src/graph-stats.ts';
function chain(n){return Array.from({length:n},(_,i)=>({id:'v'+i,dependencies:i?['v'+(i-1)]:[]}));}
function counted(vertices){let reads=0;const wrap=array=>new Proxy(array,{get(target,key,receiver){if(typeof key==='string'&&/^[0-9]+$/.test(key))reads++;return Reflect.get(target,key,receiver);}});const input=wrap(vertices.map(v=>({...v,dependencies:wrap(v.dependencies)})));return {input,reads:()=>reads};}
function oracle(vertices){const degree=new Map(vertices.map(v=>[v.id,0]));const missing=new Set();let edges=0;for(const v of vertices)for(const id of new Set(v.dependencies)){if(degree.has(id)){degree.set(id,degree.get(id)+1);edges++;}else missing.add(id);}return {nodes:vertices.length,edges,inDegree:degree,roots:[...degree].filter(([,n])=>n===0).map(([id])=>id).sort(),missing:[...missing].sort()};}

test('hidden/resource-dense-budget', async () => {
  const graph=Array.from({length:90},(_,i)=>({id:String(i),dependencies:Array.from({length:90},(_,j)=>String(j))}));const measured=counted(graph);assert.deepEqual(candidate.graphStats(measured.input),oracle(graph));assert.ok(measured.reads()<=12*(90+8100+1));
});

test('hidden/differential-permutations', async () => {
  for(let seed=1;seed<=12;seed++){const graph=Array.from({length:80},(_,i)=>({id:'n'+i,dependencies:Array.from({length:7},(_,j)=>'n'+((i*seed+j*17)%95))}));const frozen=JSON.stringify(graph);assert.deepEqual(candidate.graphStats(graph),oracle(graph));assert.deepEqual(candidate.graphStats([...graph].reverse()),oracle(graph));assert.equal(JSON.stringify(graph),frozen);}
});

test('hidden/resource-paired-scaling', async () => {
  const med=fn=>{const samples=[];for(let i=0;i<3;i++){const start=performance.now();fn();samples.push(performance.now()-start);}samples.sort((a,b)=>a-b);return samples[1];};
  for(const size of [1000,3000,9000]){const graph=chain(size);const baseline=med(()=>oracle(graph));const actual=med(()=>candidate.graphStats(graph));console.log(JSON.stringify({size,baselineMs:baseline,candidateMs:actual}));assert.ok(actual<=Math.max(100,baseline*12),'同机配对预算失败 '+size+': '+actual+'ms');}
});

test('hidden/state-input-changes-do-not-reuse-stale-index',()=>{
  const graph=[{id:'a',dependencies:[] as string[]},{id:'b',dependencies:[] as string[]}];
  assert.deepEqual(candidate.graphStats(graph),oracle(graph));
  graph[0]!.dependencies.push('b');
  assert.deepEqual(candidate.graphStats(graph),oracle(graph));
  assert.throws(()=>candidate.graphStats([graph[0]!,graph[0]!]),RangeError);
  graph[0]!.dependencies.length=0;
  assert.deepEqual(candidate.graphStats(graph),oracle(graph));
});
