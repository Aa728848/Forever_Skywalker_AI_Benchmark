import test from 'node:test';
import assert from 'node:assert/strict';
import { DependencyWorkspace, type Document } from '../starter/src/workspace.ts';

function evaluate(document: Document, get: (id: string) => Document | undefined): string {
  return document.value + ':' + document.deps.map(id => get(id)?.value ?? '<missing>').join(',');
}

test('public/detached-diamond-publication', async () => {
  const documents = [
    { id: 'root', deps: [], value: 'r0' }, { id: 'left', deps: ['root'], value: 'l' },
    { id: 'right', deps: ['root'], value: 'r' }, { id: 'app', deps: ['left', 'right'], value: 'a' },
    { id: 'other', deps: [], value: 'o' },
  ];
  const workspace = new DependencyWorkspace(documents);
  assert.equal(workspace.snapshot(), null);
  const initial = await workspace.prepare(evaluate);
  assert.equal(workspace.snapshot(), null);
  assert.equal(workspace.commit(initial), true);
  const before = workspace.snapshot();
  workspace.apply([{ kind: 'put', document: { id: 'root', deps: [], value: 'r1' } }]);
  const calls: string[] = [];
  const prepared = await workspace.prepare((doc, get) => { calls.push(doc.id); return evaluate(doc, get); });
  assert.deepEqual(prepared.affected, ['app', 'left', 'right', 'root']);
  assert.deepEqual(calls.sort(), prepared.affected);
  assert.deepEqual(workspace.snapshot(), before);
  assert.equal(workspace.commit(prepared), true);
  assert.equal(workspace.snapshot()!.generation, 1);
  assert.equal(workspace.snapshot()!.diagnostics.find(row => row.id === 'left')!.value, 'l:r1');
});

test('public/delete-and-recreate-unresolved-reference', async () => {
  const workspace = new DependencyWorkspace([{ id: 'view', deps: ['model'], value: 'v' }, { id: 'model', deps: [], value: 'm0' }]);
  workspace.commit(await workspace.prepare(evaluate));
  workspace.apply([{ kind: 'delete', id: 'model' }]);
  const calls: string[] = [];
  const deleted = await workspace.prepare((doc, get) => { calls.push(doc.id); return evaluate(doc, get); });
  assert.deepEqual(deleted.affected, ['model', 'view']);
  assert.deepEqual(calls, ['view']);
  workspace.commit(deleted);
  assert.deepEqual(workspace.snapshot()!.diagnostics, [{ id: 'view', value: 'v:<missing>' }]);
  workspace.apply([{ kind: 'put', document: { id: 'model', deps: [], value: 'm1' } }]);
  const restored = await workspace.prepare(evaluate);
  assert.deepEqual(restored.affected, ['model', 'view']);
  workspace.commit(restored);
  assert.equal(workspace.snapshot()!.diagnostics.find(row => row.id === 'view')!.value, 'v:m1');
});

