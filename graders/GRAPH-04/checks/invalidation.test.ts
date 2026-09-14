import test from 'node:test';
import assert from 'node:assert/strict';
import { Invalidator, UnknownNodeError } from '../starter/src/invalidation.ts';
import { DependencyWorkspace, type Document, type Change, type Prepared } from '../starter/src/workspace.ts';

const seed: Document[] = [
  { id: 'a', deps: ['c'], value: 'a0' }, { id: 'b', deps: ['a'], value: 'b0' },
  { id: 'c', deps: ['b'], value: 'c0' }, { id: 'view', deps: ['a', 'b'], value: 'v0' },
  { id: 'other', deps: [], value: 'o0' },
];
function evaluate(document: Document, get: (id: string) => Document | undefined): string {
  const pending = [document.id];
  const reached = new Map<string, string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (reached.has(id)) continue;
    const next = get(id);
    reached.set(id, next?.value ?? '<missing>');
    if (next) for (const dependency of next.deps) pending.push(dependency);
  }
  return JSON.stringify([...reached].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
function oracle(documents: readonly Document[]) {
  const map = new Map(documents.map(document => [document.id, document]));
  return [...map.keys()].sort().map(id => ({ id, value: evaluate(map.get(id)!, key => map.get(key)) }));
}
function affected(documents: readonly Document[], changed: readonly string[]): string[] {
  const result = new Set(changed);
  let grew = true;
  while (grew) {
    grew = false;
    for (const document of documents) if (!result.has(document.id) && document.deps.some(id => result.has(id))) {
      result.add(document.id); grew = true;
    }
  }
  return [...result].sort();
}
async function initial(documents: readonly Document[] = seed) {
  const workspace = new DependencyWorkspace(documents);
  assert.equal(workspace.commit(await workspace.prepare(evaluate)), true);
  return workspace;
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test('hidden/replaced-edges-have-no-ghost-consumers', async () => {
  const workspace = await initial([
    { id: 'old', deps: [], value: 'o' }, { id: 'new', deps: [], value: 'n' },
    { id: 'consumer', deps: ['old'], value: 'c' }, { id: 'top', deps: ['consumer'], value: 't' },
  ]);
  workspace.apply([{ kind: 'put', document: { id: 'consumer', deps: ['new', 'new'], value: 'c' } }]);
  workspace.commit(await workspace.prepare(evaluate));
  workspace.apply([{ kind: 'put', document: { id: 'old', deps: [], value: 'o1' } }]);
  const calls: string[] = [];
  const result = await workspace.prepare((doc, get) => { calls.push(doc.id); return evaluate(doc, get); });
  assert.deepEqual(result.affected, ['old']);
  assert.deepEqual(calls, ['old']);
  workspace.commit(result);
  workspace.apply([{ kind: 'put', document: { id: 'new', deps: [], value: 'n1' } }]);
  assert.deepEqual((await workspace.prepare(evaluate)).affected, ['consumer', 'new', 'top']);
});

test('hidden/unpublished-batches-coalesce-with-tombstones', async () => {
  const workspace = await initial();
  workspace.apply([{ kind: 'delete', id: 'a' }]);
  workspace.apply([{ kind: 'put', document: { id: 'other', deps: [], value: 'o1' } }]);
  const ticket = await workspace.prepare(evaluate);
  assert.deepEqual(ticket.affected, ['a', 'b', 'c', 'other', 'view']);
  workspace.commit(ticket);
  assert.deepEqual(workspace.snapshot()!.diagnostics, oracle(workspace.snapshot()!.documents));
  assert.equal(workspace.snapshot()!.diagnostics.some(item => item.id === 'a'), false);
});

test('hidden/old-generation-cannot-publish-or-acknowledge', async () => {
  const workspace = await initial();
  const before = workspace.snapshot();
  workspace.apply([{ kind: 'put', document: { id: 'a', deps: ['c'], value: 'a1' } }]);
  const gate = deferred();
  let entered = false;
  const stale = workspace.prepare(async (doc, get) => { entered = true; await gate.promise; return evaluate(doc, get); });
  assert.equal(entered, true);
  workspace.apply([{ kind: 'put', document: { id: 'other', deps: [], value: 'o2' } }]);
  gate.release();
  const ticket = await stale;
  assert.equal(workspace.commit(ticket), false);
  assert.deepEqual(workspace.snapshot(), before);
  const next = await workspace.prepare(evaluate);
  assert.deepEqual(next.affected, ['a', 'b', 'c', 'other', 'view']);
  assert.equal(workspace.commit(next), true);
  assert.deepEqual(workspace.snapshot()!.diagnostics, oracle(workspace.snapshot()!.documents));
  assert.equal(workspace.commit(ticket), false);
});

test('hidden/preparation-failure-rolls-back-only-derived-work', async () => {
  const workspace = await initial();
  const before = workspace.snapshot();
  workspace.apply([{ kind: 'put', document: { id: 'a', deps: ['c'], value: 'a1' } }]);
  await assert.rejects(workspace.prepare(doc => { if (doc.id === 'view') throw new Error('diagnostic store fault'); return doc.value; }), /diagnostic store fault/);
  assert.deepEqual(workspace.snapshot(), before);
  assert.equal(workspace.generation, 1, 'accepted edit must survive a derived computation failure');
  const retry = await workspace.prepare(evaluate);
  assert.deepEqual(retry.affected, ['a', 'b', 'c', 'view']);
  workspace.commit(retry);
  assert.deepEqual(workspace.snapshot()!.diagnostics, oracle(workspace.snapshot()!.documents));
});

test('hidden/invalid-batch-is-atomic-and-empty-batch-preserves-ticket', async () => {
  const workspace = await initial();
  const before = workspace.snapshot();
  const changes: Change[] = [
    { kind: 'put', document: { id: 'other', deps: ['missing'], value: 'changed' } },
    { kind: 'delete', id: 'absent' },
  ];
  assert.throws(() => workspace.apply(changes), UnknownNodeError);
  assert.throws(() => workspace.apply([changes[0]!, changes[0]!]), TypeError);
  assert.equal(workspace.generation, 0);
  assert.deepEqual(workspace.snapshot(), before);
  const ticket = await workspace.prepare(() => { throw new Error('no pending work'); });
  assert.deepEqual(ticket.affected, []);
  assert.equal(workspace.apply([]), 0);
  assert.equal(workspace.commit(ticket), true);
  assert.throws(() => new DependencyWorkspace([seed[0]!, seed[0]!]), TypeError);
  const batch: Change[] = [
    { kind: 'delete', id: 'b' },
    { kind: 'put', document: { id: 'a', deps: ['replacement'], value: 'a1' } },
    { kind: 'put', document: { id: 'replacement', deps: [], value: 'r' } },
  ];
  const left = await initial([{ id: 'a', deps: ['b'], value: 'a' }, { id: 'b', deps: [], value: 'b' }]);
  const right = await initial([{ id: 'b', deps: [], value: 'b' }, { id: 'a', deps: ['b'], value: 'a' }]);
  left.apply(batch); right.apply([...batch].reverse());
  left.commit(await left.prepare(evaluate)); right.commit(await right.prepare(evaluate));
  assert.deepEqual(left.snapshot(), right.snapshot(), 'batch semantics cannot depend on transient operation order');
});

test('hidden/ticket-identity-and-late-sibling-are-enforced', async () => {
  const workspace = await initial();
  workspace.apply([{ kind: 'put', document: { id: 'other', deps: [], value: 'next' } }]);
  const gate = deferred();
  const slow = workspace.prepare(async doc => { await gate.promise; return doc.value; });
  const fast = await workspace.prepare(evaluate);
  assert.equal(Reflect.set(fast.affected, '0', 'forged'), false);
  assert.equal(workspace.commit({ ...fast } as Prepared), false);
  const foreign = await initial();
  assert.equal(foreign.commit(fast), false);
  assert.equal(workspace.commit(fast), true);
  const published = workspace.snapshot();
  gate.release();
  assert.equal(workspace.commit(await slow), false);
  assert.equal(workspace.commit(fast), false);
  assert.deepEqual(workspace.snapshot(), published);
});

test('hidden/frozen-input-and-reader-snapshot-survive-reentrant-edit', async () => {
  const input = [{ id: 'source', deps: [] as string[], value: 'old' }, { id: 'view', deps: ['source'], value: 'v' }];
  const workspace = await initial(input);
  input[0]!.value = 'outside';
  input[1]!.deps.length = 0;
  const published = workspace.snapshot()!;
  assert.equal(Reflect.set(published.documents[0]!, 'value', 'outside'), false);
  assert.equal(Reflect.set(published.documents[1]!.deps, '0', 'outside'), false);
  assert.equal(Reflect.set(published.diagnostics[0]!, 'value', 'outside'), false);
  workspace.apply([{ kind: 'put', document: { id: 'source', deps: [], value: 'new' } }]);
  let reentered = false;
  const capturedValues: string[] = [];
  const ticket = await workspace.prepare((doc, get) => {
    if (!reentered) {
      reentered = true;
      workspace.apply([{ kind: 'put', document: { id: 'source', deps: [], value: 'newer' } }]);
    }
    capturedValues.push(get('source')!.value);
    return evaluate(doc, get);
  });
  assert.deepEqual(capturedValues, ['new', 'new']);
  assert.equal(workspace.commit(ticket), false);
  assert.deepEqual(workspace.snapshot(), published);
  workspace.commit(await workspace.prepare(evaluate));
  assert.deepEqual(workspace.snapshot()!.diagnostics, oracle(workspace.snapshot()!.documents));
});

test('hidden/seeded-churn-matches-independent-full-rebuild', async () => {
  let random = 0x51a7;
  const next = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random; };
  let documents: Document[] = Array.from({ length: 24 }, (_, i) => ({ id: 'n' + i, deps: ['n' + ((i + 1) % 24)], value: String(i) }));
  const workspace = await initial(documents);
  for (let round = 0; round < 75; round++) {
    const changed = ['n' + (next() % 32), 'n' + (next() % 32)].filter((id, i, ids) => ids.indexOf(id) === i);
    const records = new Map(documents.map(document => [document.id, document]));
    const changes: Change[] = changed.map(id => {
      if (records.has(id) && next() % 4 === 0) { records.delete(id); return { kind: 'delete', id }; }
      const document = { id, deps: ['n' + (next() % 32), 'n' + (next() % 32)], value: String(next()) };
      records.set(id, document); return { kind: 'put', document };
    });
    const after = [...records.values()];
    const expected = [...new Set([...affected(documents, changed), ...affected(after, changed)])].sort();
    workspace.apply(changes);
    const calls: string[] = [];
    const ticket = await workspace.prepare((document, get) => { calls.push(document.id); return evaluate(document, get); });
    assert.deepEqual(ticket.affected, expected, 'affected closure at round ' + round);
    assert.deepEqual(calls.sort(), expected.filter(id => records.has(id)), 'work count at round ' + round);
    assert.equal(workspace.commit(ticket), true);
    assert.deepEqual(workspace.snapshot()!.diagnostics, oracle(after), 'derived snapshot at round ' + round);
    documents = after;
  }
});

test('hidden/sparse-edits-do-not-reevaluate-unrelated-documents', async () => {
  const ring = Array.from({ length: 128 }, (_, i) => ({ id: 'ring-' + i, deps: ['ring-' + ((i + 1) % 128)], value: String(i) }));
  const cold = Array.from({ length: 12_000 }, (_, i) => ({ id: 'cold-' + i, deps: [], value: String(i) }));
  const workspace = await initial([...ring, ...cold]);
  let total = 0;
  for (let iteration = 0; iteration < 80; iteration++) {
    const id = 'cold-' + ((iteration * 7919) % cold.length);
    workspace.apply([{ kind: 'put', document: { id, deps: [], value: 'changed-' + iteration } }]);
    const ticket = await workspace.prepare((document, get) => { total++; return evaluate(document, get); });
    assert.deepEqual(ticket.affected, [id]);
    workspace.commit(ticket);
  }
  assert.equal(total, 80, 'evaluations measured by trusted callback, not candidate counters');
  workspace.apply([{ kind: 'put', document: { id: 'ring-0', deps: ['ring-1'], value: 'changed' } }]);
  const calls: string[] = [];
  const ticket = await workspace.prepare((document, get) => { calls.push(document.id); return evaluate(document, get); });
  assert.equal(calls.length, 128);
  assert.equal(new Set(calls).size, 128);
  workspace.commit(ticket);
  assert.deepEqual(workspace.snapshot()!.diagnostics, oracle(workspace.snapshot()!.documents));
});

test('hidden/resource-deep-cycle-terminates', () => {
  const count = 20_000;
  const nodes = Array.from({ length: count }, (_, index) => ({ id: String(index), deps: [String((index + count - 1) % count)] }));
  const invalidator = new Invalidator(nodes);
  const actual = invalidator.invalidate(['0', '0']);
  const expected = nodes.map(node => node.id).sort();
  // Keep failure diagnostics bounded: a full 20,000-entry diff can exhaust the test container.
  assert.ok(Array.isArray(actual));
  assert.equal(actual.length, expected.length, 'every node in the deep cycle must be affected');
  for (let index = 0; index < expected.length; index++) assert.equal(actual[index], expected[index], 'sorted affected node at ' + index);
  assert.deepEqual(invalidator.invalidate([]), []);
});
