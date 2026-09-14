import test from 'node:test';
import assert from 'node:assert/strict';
import { runBrowser } from './browser.ts';

const observed = runBrowser<{
  initialIds: string[]; initialRole: string | null; initialCount: number;
  sameNodes: boolean; focused: boolean; valuesAfterPatch: string[];
  clickedValue: string; nextIds: string[]; disposedCount: number; rejectedAfterDispose: boolean;
}>(new URL('../starter/src/window.ts', import.meta.url), `
  const source = Array.from({length:10000}, (_, index) => Object.freeze({id:'row-'+index,value:index}));
  Object.freeze(source);
  const root = document.createElement('div'); document.body.append(root);
  const list = candidate.mountList(root, source, {offset:20,size:3});
  const firstNodes = [...root.children];
  const firstButton = firstNodes[0].querySelector('button'); firstButton.focus();
  const initialIds = firstNodes.map(node => node.dataset.rowId);
  const initialRole = root.getAttribute('role');
  const initialCount = root.querySelectorAll('button').length;
  list.applyPatch({id:'row-21',value:400});
  const sameNodes = firstNodes.every((node,index) => node === root.children[index]);
  const focused = document.activeElement === firstButton;
  const valuesAfterPatch = [...root.querySelectorAll('button')].map(node => node.textContent);
  root.querySelectorAll('button')[2].click();
  const clickedValue = root.querySelectorAll('button')[2].textContent;
  list.setWindow({offset:21,size:3});
  const nextIds = [...root.children].map(node => node.dataset.rowId);
  list.dispose(); list.dispose();
  const disposedCount = root.children.length;
  let rejectedAfterDispose = false;
  try { list.applyPatch({id:'row-21',value:1}); } catch { rejectedAfterDispose = true; }
  return {initialIds,initialRole,initialCount,sameNodes,focused,valuesAfterPatch,clickedValue,nextIds,disposedCount,rejectedAfterDispose};
`);

test('public/browser-renders-only-visible-rows', () => {
  assert.equal(observed.initialRole, 'list');
  assert.equal(observed.initialCount, 3);
  assert.deepEqual(observed.initialIds, ['row-20', 'row-21', 'row-22']);
});
test('public/dom-preserves-nodes-and-focus', () => {
  assert.equal(observed.sameNodes, true, '局部更新不得重建可见行节点');
  assert.equal(observed.focused, true, '未更新行的焦点必须保留');
  assert.deepEqual(observed.valuesAfterPatch, ['row-20: 20', 'row-21: 400', 'row-22: 22']);
});
test('public/browser-click-and-window-change', () => {
  assert.equal(observed.clickedValue, 'row-22: 23');
  assert.deepEqual(observed.nextIds, ['row-21', 'row-22', 'row-23']);
});
test('public/browser-dispose-is-idempotent', () => {
  assert.equal(observed.disposedCount, 0);
  assert.equal(observed.rejectedAfterDispose, true);
});
