import test from 'node:test';
import assert from 'node:assert/strict';

import {runBrowser} from './browser.ts';
const source=new URL('../starter/src/workspace-view.ts',import.meta.url);

test('public/connect-synchronous-dispose-reclaims-returned-handle',()=>{const result=runBrowser(source,"const root=document.createElement('div');let view,closed=0,emit;view=candidate.mount(root,(_w,_s,push)=>{emit=push;view.dispose();return ()=>closed++;},{maxRows:2,maxWorkspaces:2});view.switchWorkspace('a');emit({kind:'append',sequence:1,id:'late',text:'late'});view.dispose();return {closed,stats:view.stats(),nodes:root.children.length};");assert.deepEqual(result,{closed:1,stats:{workspace:null,sequence:0,retainedRows:0,cachedWorkspaces:0},nodes:0});});
