import test from 'node:test';
import assert from 'node:assert/strict';
import { Invalidator, UnknownNodeError, type Node } from '../starter/src/invalidation.ts';

function naive(nodes: readonly Node[], changed: readonly string[]): string[] {
  const edges = new Map<string, string[]>();
  for (const node of nodes) edges.set(node.id, []);
  for (const node of nodes) for (const dependency of node.deps) (edges.get(dependency) as string[]).push(node.id);
  const affected = new Set<string>();
  for (const start of changed) {
    const stack: string[] = [start];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (affected.has(current)) continue;
      affected.add(current);
      for (const next of edges.get(current) ?? []) stack.push(next);
    }
  }
  return [...affected].sort();
}

const graph: Node[] = [
  { id: 'app', deps: ['router', 'store'] },
  { id: 'router', deps: ['config'] },
  { id: 'store', deps: ['config', 'db'] },
  { id: 'config', deps: [] },
  { id: 'db', deps: [] },
  { id: 'unrelated', deps: [] },
];

const cyclic: Node[] = [
  { id: 'a', deps: ['c'] },
  { id: 'b', deps: ['a'] },
  { id: 'c', deps: ['b'] },
  { id: 'leaf', deps: ['a'] },
];

test('hidden/direct-dependents', () => {
  const invalidator = new Invalidator(graph);
  assert.deepEqual(invalidator.invalidate(['db']), ['app', 'db', 'store']);
});

test('hidden/transitive-matches-naive-scan', () => {
  const invalidator = new Invalidator(graph);
  assert.deepEqual(invalidator.invalidate(['config']), ['app', 'config', 'router', 'store']);
  assert.deepEqual(invalidator.invalidate(['config', 'db']), naive(graph, ['config', 'db']));
});

test('hidden/cycles-converge', () => {
  const invalidator = new Invalidator(cyclic);
  assert.deepEqual(invalidator.invalidate(['a']), ['a', 'b', 'c', 'leaf']);
  assert.deepEqual(invalidator.invalidate(['a']), naive(cyclic, ['a']));
});

test('hidden/result-is-sorted-and-input-order-independent', () => {
  const invalidator = new Invalidator(graph);
  assert.deepEqual(invalidator.invalidate(['app', 'config']), ['app', 'config', 'router', 'store']);
  assert.deepEqual(invalidator.invalidate(['unrelated']), ['unrelated']);
  assert.deepEqual(new Invalidator([...graph].reverse()).invalidate(['config']), invalidator.invalidate(['config']));
});

test('hidden/rejects-unknown-nodes', () => {
  const invalidator = new Invalidator(graph);
  assert.throws(() => invalidator.invalidate(['nope']), (error: unknown) => error instanceof UnknownNodeError && error.node === 'nope');
  assert.throws(() => new Invalidator([{ id: 'x', deps: ['missing'] }]), UnknownNodeError);
});
