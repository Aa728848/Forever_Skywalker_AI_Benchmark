import test from 'node:test';
import assert from 'node:assert/strict';
import * as candidate from '../starter/src/workspace-view.ts';
import {runBrowser} from './browser.ts';
const source=new URL('../starter/src/workspace-view.ts',import.meta.url);

test('hidden/state-workspace-eviction', async () => {
  const result=runBrowser(source,"const root=document.createElement('div');const calls=[];let emit;const view=candidate.mount(root,(id,seq,next)=>{calls.push([id,seq]);emit=next;return ()=>{};},{maxRows:2,maxWorkspaces:2});for(const id of ['a','b','c']){view.switchWorkspace(id);emit({kind:'append',sequence:1,id,text:id});}view.switchWorkspace('a');const result={calls,stats:view.stats(),nodes:root.querySelectorAll('article').length};view.dispose();return result;");assert.deepEqual(result,{calls:[['a',0],['b',0],['c',0],['a',0]],stats:{workspace:'a',sequence:0,retainedRows:1,cachedWorkspaces:2},nodes:0});
});

test('hidden/state-snapshot-gap-and-dispose', async () => {
  const result=runBrowser(source,"const root=document.createElement('div');let emit,closed=0;const view=candidate.mount(root,(_w,_s,next)=>{emit=next;return ()=>closed++;},{maxRows:2,maxWorkspaces:1});view.switchWorkspace('a');emit({kind:'snapshot',sequence:100000,rows:[{id:'a',text:'confirmed'}]});emit({kind:'append',sequence:100002,id:'bad',text:'gap'});const gap=root.querySelector('[role=alert]').textContent;emit({kind:'append',sequence:100001,id:'a',text:'next'});const before=view.stats().sequence;view.dispose();emit({kind:'append',sequence:100002,id:'late',text:'ignored'});return {gap,before,closed,nodes:root.children.length};");assert.deepEqual(result,{gap:'sequence gap',before:100001,closed:1,nodes:0});
});

test('hidden/resource-100000-events-retained-heap', async () => {
  const result=runBrowser<{rows:number;sequence:number;after:number;delta:number}>(source,"const root=document.createElement('div');document.body.append(root);let emit;const starts=[];const view=candidate.mount(root,(_w,after,next)=>{starts.push(after);emit=next;return ()=>{};},{maxRows:100,maxWorkspaces:2});view.switchWorkspace('a');if(typeof gc!=='function'||!performance.memory)throw new Error('precise heap runtime missing');gc();const before=performance.memory.usedJSHeapSize;for(let i=1;i<=100000;i++)emit({kind:'append',sequence:i,id:String(i),text:String(i)+'x'.repeat(256)});gc();const delta=performance.memory.usedJSHeapSize-before;const rows=root.querySelectorAll('article').length;view.switchWorkspace('a');emit({kind:'append',sequence:100001,id:'tail',text:'continued'});const result={rows,sequence:view.stats().sequence,after:starts[1],delta};view.dispose();return result;");console.log(JSON.stringify(result));assert.equal(result.rows,100);assert.equal(result.sequence,100001);assert.equal(result.after,100000);assert.ok(result.delta<32*1024*1024,'retained heap exceeds 32MiB: '+result.delta);
});
