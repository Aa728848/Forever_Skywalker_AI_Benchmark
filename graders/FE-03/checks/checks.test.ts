import test from 'node:test';
import assert from 'node:assert/strict';
import * as candidate from '../starter/src/stream-view.ts';
import {runBrowser} from './browser.ts';
const source=new URL('../starter/src/stream-view.ts',import.meta.url);

test('hidden/state-gap-and-atomic-snapshot', async () => {
  const result=runBrowser(source,"const root=document.createElement('div');const view=candidate.mount(root,()=>{});view.snapshot(3,[{id:'a',text:'<script>safe</script>'}]);let gap=false,duplicate=false;try{view.append(5,'a','x');}catch(e){gap=String(e).includes('gap');}try{view.snapshot(4,[{id:'a',text:'x'},{id:'a',text:'y'}]);}catch(e){duplicate=e instanceof RangeError;}return {gap,duplicate,seq:view.lastSequence(),text:root.querySelector('article').textContent,scripts:root.querySelectorAll('script').length};");assert.deepEqual(result,{gap:true,duplicate:true,seq:3,text:'<script>safe</script>',scripts:0});
});

test('hidden/resource-scroll-and-disposal', async () => {
  const result=runBrowser(source,"const root=document.createElement('div');root.style.cssText='height:100px;overflow:auto;overflow-anchor:none';document.body.append(root);const style=document.createElement('style');style.textContent='article{height:24px}';document.head.append(style);let calls=0;const view=candidate.mount(root,()=>calls++);view.snapshot(1,Array.from({length:100},(_,i)=>({id:String(i),text:'line '+i})));root.scrollTop=48;view.append(2,'100','last');const top=root.scrollTop;view.fail('error');const button=root.querySelector('button');view.dispose();button.click();const accepted=view.append(3,'late','bad');return {top,calls,accepted,children:root.children.length};");assert.deepEqual(result,{top:48,calls:0,accepted:false,children:0});
});

test('hidden/reordered-snapshot-preserves-nodes', async () => {
  const result=runBrowser(source,"const root=document.createElement('div');const view=candidate.mount(root,()=>{});view.snapshot(1,[{id:'a',text:'A'},{id:'b',text:'B'}]);const a=root.querySelector('article');view.snapshot(2,[{id:'b',text:'B2'},{id:'a',text:'A2'}]);return {identity:root.querySelectorAll('article')[1]===a,ids:Array.from(root.querySelectorAll('article'),node=>node.dataset.messageId),texts:Array.from(root.querySelectorAll('article'),node=>node.textContent)};");assert.deepEqual(result,{identity:true,ids:['b','a'],texts:['B2','A2']});
});
