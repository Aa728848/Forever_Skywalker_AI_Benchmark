import test from 'node:test';
import assert from 'node:assert/strict';
import * as candidate from '../starter/src/graph-stats.ts';
function chain(n:number):candidate.Vertex[]{return Array.from({length:n},(_,i)=>({id:'v'+i,dependencies:i?['v'+(i-1)]:[]}));}
function counted(vertices:readonly candidate.Vertex[]){let reads=0;const wrap=<T>(array:readonly T[]):readonly T[]=>new Proxy(array,{get(target,key,receiver){if(typeof key==='string'&&/^[0-9]+$/.test(key))reads++;return Reflect.get(target,key,receiver);}});const input=wrap(vertices.map(v=>({...v,dependencies:wrap(v.dependencies)})));return {input,reads:()=>reads};}
function oracle(vertices:readonly candidate.Vertex[]):candidate.Stats{const degree=new Map(vertices.map(v=>[v.id,0]));const missing=new Set<string>();let edges=0;for(const v of vertices)for(const id of new Set(v.dependencies)){if(degree.has(id)){degree.set(id,degree.get(id)!+1);edges++;}else missing.add(id);}return {nodes:vertices.length,edges,inDegree:degree,roots:[...degree].filter(([,n])=>n===0).map(([id])=>id).sort(),missing:[...missing].sort()};}

test('public/graph-semantics', async () => {
  const graph=[{id:'a',dependencies:['a','b','b','missing']},{id:'b',dependencies:[]}];assert.deepEqual(candidate.graphStats(graph),oracle(graph));
});

test('public/resource-linear-sparse', async () => {
  const measured=counted(chain(200));assert.deepEqual(candidate.graphStats(measured.input),oracle(chain(200)));assert.ok(measured.reads()<=12*400,'读取必须线性，实际'+measured.reads());
});

test('public/boundary-duplicate-and-empty', async () => {
  assert.throws(()=>candidate.graphStats([{id:'a',dependencies:[]},{id:'a',dependencies:[]}]),RangeError);assert.deepEqual(candidate.graphStats([]),oracle([]));
});
