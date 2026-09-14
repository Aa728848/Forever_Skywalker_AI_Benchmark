import test from 'node:test';
import assert from 'node:assert/strict';
import {CycleError,topologicalOrder} from '../starter/src/graph.ts';
test('hidden/cycle-edges-and-permutation-invariance',()=>{
 const nodes=['prefix','z','y','a','b','tail'];const edges=[{from:'prefix',to:'z'},{from:'z',to:'y'},{from:'y',to:'z'},{from:'a',to:'b'},{from:'b',to:'a'},{from:'y',to:'tail'}];let expected;
 for(let shift=0;shift<nodes.length;shift++){
  const perm=[...nodes.slice(shift),...nodes.slice(0,shift)];
  assert.throws(()=>topologicalOrder(perm,shift%2?[...edges].reverse():edges),e=>{assert.ok(e instanceof CycleError);const path=e.path;assert.ok(path.length>=2);assert.equal(path[0],path.at(-1));for(let i=1;i<path.length;i++)assert.ok(edges.some(edge=>edge.from===path[i-1]&&edge.to===path[i]));if(expected)assert.deepEqual(path,expected);else expected=[...path];return true;});
 }
 assert.throws(()=>topologicalOrder(['single'],[{from:'single',to:'single'}]),e=>e instanceof CycleError&&JSON.stringify(e.path)==='["single","single"]');
});
test('hidden/independent-dag-order',()=>{
 for(let seed=1;seed<=20;seed++){
  const nodes=Array.from({length:13},(_,i)=>'n'+i);const edges=[];for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++)if((i*17+j*seed)%7===0)edges.push({from:nodes[i],to:nodes[j]});
  const remaining=new Set(nodes);const expected=[];while(remaining.size){const next=[...remaining].filter(id=>!edges.some(e=>e.to===id&&remaining.has(e.from))).sort()[0];expected.push(next);remaining.delete(next);}
  assert.deepEqual(topologicalOrder([...nodes].reverse(),[...edges,...edges].reverse()),expected);
 }
});
