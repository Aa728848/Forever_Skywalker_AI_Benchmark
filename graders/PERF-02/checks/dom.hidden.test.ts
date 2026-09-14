import test from 'node:test';
import assert from 'node:assert/strict';
import { runBrowser } from './browser.ts';

const observed = runBrowser<{
  overlapPreserved: boolean; mutationCount: number; literalLabel: string; injectedImages: number;
  patchSurvived: string; invalidWindowRejected: boolean; windowAfterInvalid: string[]; remainingListeners: number;
}>(new URL('../starter/src/window.ts', import.meta.url), `
  const root = document.createElement('div'); document.body.append(root);
  const registrations = new Set();
  const add = root.addEventListener.bind(root); const remove = root.removeEventListener.bind(root);
  root.addEventListener = (type, listener, options) => { if(type === 'click') registrations.add(listener); add(type,listener,options); };
  root.removeEventListener = (type, listener, options) => { if(type === 'click') registrations.delete(listener); remove(type,listener,options); };
  const rows = [{id:'',value:7},{id:'<img src=x onerror=alert(1)>',value:8},{id:'中文[]',value:9},{id:'last',value:10}];
  const view = candidate.mountList(root, Object.freeze(rows.map(Object.freeze)), {offset:0,size:3});
  const original = [...root.children];
  const literalLabel = root.children[1].querySelector('button').textContent;
  const injectedImages = root.querySelectorAll('img').length;
  const observer = new MutationObserver(() => {}); observer.observe(root,{subtree:true,childList:true,characterData:true,attributes:true});
  view.applyPatch({id:'last',value:999});
  view.applyPatch({id:'',value:7});
  const mutationCount = observer.takeRecords().length;
  view.applyPatch({id:'中文[]',value:88});
  view.setWindow({offset:1,size:3});
  const overlapPreserved = original[1] === root.children[0] && original[2] === root.children[1];
  view.setWindow({offset:0,size:3});
  const patchSurvived = root.children[2].querySelector('button').textContent;
  let invalidWindowRejected = false;
  try { view.setWindow({offset:-1,size:3}); } catch(error) { invalidWindowRejected = error instanceof RangeError; }
  const windowAfterInvalid = [...root.children].map(item => item.dataset.rowId);
  observer.disconnect(); view.dispose();
  return {overlapPreserved,mutationCount,literalLabel,injectedImages,patchSurvived,invalidWindowRejected,windowAfterInvalid,
    remainingListeners:registrations.size + (root.onclick === null ? 0 : 1)};
`);

test('hidden/dom-reuses-overlapping-window-rows', () => assert.equal(observed.overlapPreserved, true));
test('hidden/dom-ignores-offscreen-and-unchanged-patches', () => assert.equal(observed.mutationCount, 0));
test('hidden/browser-text-is-literal-and-updates-persist', () => {
  assert.equal(observed.literalLabel, '<img src=x onerror=alert(1)>: 8');
  assert.equal(observed.injectedImages, 0);
  assert.equal(observed.patchSurvived, '中文[]: 88');
});
test('hidden/browser-invalid-window-and-listener-cleanup', () => {
  assert.equal(observed.invalidWindowRejected, true);
  assert.deepEqual(observed.windowAfterInvalid, ['', '<img src=x onerror=alert(1)>', '中文[]']);
  assert.equal(observed.remainingListeners, 0);
});
