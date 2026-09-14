import test from 'node:test';
import assert from 'node:assert/strict';
import * as candidate from '../starter/src/workspace-view.ts';
import {runBrowser} from './browser.ts';
const source=new URL('../starter/src/workspace-view.ts',import.meta.url);

test('public/state-switch-resume-stale-events', async () => {
  assert.equal(typeof candidate.mount,'function');const result=runBrowser(source,"const root=document.createElement('div');document.body.append(root);const calls=[],handlers=[];let live=0,disposed=0;const view=candidate.mount(root,(id,after,handler)=>{calls.push([id,after]);handlers.push(handler);live++;return ()=>{live--;disposed++;};},{maxRows:3,maxWorkspaces:2});view.switchWorkspace('a');handlers[0]({kind:'append',sequence:1,id:'a',text:'A'});view.switchWorkspace('b');handlers[1]({kind:'append',sequence:1,id:'b',text:'B'});handlers[0]({kind:'append',sequence:2,id:'late',text:'WRONG'});const b=Array.from(root.querySelectorAll('article'),n=>n.textContent);view.switchWorkspace('a');handlers[0]({kind:'append',sequence:2,id:'late',text:'WRONG2'});handlers[2]({kind:'append',sequence:2,id:'a2',text:'A2'});const result={calls,b,live,disposed,text:Array.from(root.querySelectorAll('article'),n=>n.textContent)};view.dispose();return result;");assert.deepEqual(result,{calls:[['a',0],['b',0],['a',1]],b:['B'],live:1,disposed:2,text:['A','A2']});
});

test('public/resource-bounded-visible-rows', async () => {
  const result=runBrowser(source,"const root=document.createElement('div');let emit;const view=candidate.mount(root,(_w,_s,next)=>{emit=next;return ()=>{};},{maxRows:3,maxWorkspaces:2});view.switchWorkspace('a');for(let i=1;i<=10;i++)emit({kind:'append',sequence:i,id:String(i),text:'row'+i});const result={text:Array.from(root.querySelectorAll('article'),n=>n.textContent),stats:view.stats()};view.dispose();return result;");assert.deepEqual(result,{text:['row8','row9','row10'],stats:{workspace:'a',sequence:10,retainedRows:3,cachedWorkspaces:1}});
});

test('public/boundary-invalid-limits',()=>{for(const limits of [{maxRows:0,maxWorkspaces:1},{maxRows:1,maxWorkspaces:0},{maxRows:1.5,maxWorkspaces:2}])assert.throws(()=>candidate.mount({} as HTMLElement,()=>()=>{},limits),RangeError);});
