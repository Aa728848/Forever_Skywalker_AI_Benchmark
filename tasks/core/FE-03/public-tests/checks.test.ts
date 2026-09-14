import test from 'node:test';
import assert from 'node:assert/strict';
import * as candidate from '../starter/src/stream-view.ts';
import {runBrowser} from './browser.ts';
const source=new URL('../starter/src/stream-view.ts',import.meta.url);

test('public/reconnect-and-dom-identity', async () => {
  assert.equal(typeof candidate.mount,'function');const result=runBrowser(source,"const root=document.createElement('div');document.body.append(root);const view=candidate.mount(root,()=>{});view.snapshot(1,[{id:'a',text:'A'}]);const first=root.querySelector('article');view.append(2,'a','B');view.snapshot(2,[{id:'a',text:'AB'}]);const same=first===root.querySelector('article');const replay=view.append(2,'a','B');return {same,replay,text:root.querySelector('article').textContent,seq:view.lastSequence()};");assert.deepEqual(result,{same:true,replay:false,text:'AB',seq:2});
});

test('public/error-and-keyboard-retry', async () => {
  const result=runBrowser(source,"const root=document.createElement('div');document.body.append(root);let calls=0;const view=candidate.mount(root,()=>calls++);view.snapshot(1,[{id:'a',text:'confirmed'}]);view.fail('连接失败');const button=root.querySelector('button');button.focus();button.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));button.click();return {calls,text:root.querySelector('article')?.textContent,error:root.querySelector('[role=alert]').textContent,focused:document.activeElement===button};");assert.deepEqual(result,{calls:2,text:'confirmed',error:'连接失败',focused:true});
});
