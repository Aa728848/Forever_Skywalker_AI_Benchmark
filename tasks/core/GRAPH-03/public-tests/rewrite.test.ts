import test from 'node:test';
import assert from 'node:assert/strict';
import {rewriteAst} from '../starter/src/rewrite.ts';
test('public/rewrite-parent-observes-new-child',()=>{const leaf={type:'old'};const root={type:'root',children:[leaf]};const result=rewriteAst(root,node=>node.type==='old'?'new':node.children?.[0]?.type==='new'?'updated-parent':node.type);assert.equal(result.type,'updated-parent');assert.equal(result.children?.[0]?.type,'new');assert.equal(root.type,'root');assert.equal(leaf.type,'old');});
