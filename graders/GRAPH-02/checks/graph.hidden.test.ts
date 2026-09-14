import test from 'node:test';
import assert from 'node:assert/strict';
import { CycleError, UnknownNodeError, topologicalOrder, type Edge } from '../starter/src/graph.ts';

const edge = (from: string, to: string): Edge => ({ from, to });

function failureOf(run: () => unknown): string {
  try { run(); return 'ok'; } catch (error) {
    if (error instanceof CycleError) return 'cycle:' + error.path.join('>');
    if (error instanceof UnknownNodeError) return 'unknown:' + error.node;
    return 'other:' + String(error);
  }
}

test('hidden/orders-simple-dag', () => {
  const order = topologicalOrder(['c', 'a', 'b'], [edge('a', 'b'), edge('b', 'c')]);
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('hidden/lexicographic-tiebreak-is-deterministic', () => {
  const edges = [edge('root', 'delta'), edge('root', 'alpha'), edge('root', 'charlie')];
  assert.deepEqual(topologicalOrder(['root', 'delta', 'alpha', 'charlie'], edges), ['root', 'alpha', 'charlie', 'delta']);
  assert.deepEqual(topologicalOrder(['charlie', 'alpha', 'delta', 'root'], edges), ['root', 'alpha', 'charlie', 'delta']);
});

test('hidden/deduplicates-repeated-edges', () => {
  const order = topologicalOrder(['a', 'b'], [edge('a', 'b'), edge('a', 'b'), edge('a', 'b')]);
  assert.deepEqual(order, ['a', 'b']);
});

test('hidden/detects-cycles-with-path', () => {
  const failure = failureOf(() => topologicalOrder(['a', 'b', 'c'], [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')]));
  assert.ok(failure.startsWith('cycle:'), '必须报环，实际 ' + failure);
  const path = failure.slice('cycle:'.length).split('>');
  assert.equal(path[0], path[path.length - 1]);
  assert.ok(path.length >= 3);
  assert.equal(failureOf(() => topologicalOrder(['a'], [edge('a', 'missing')])), 'unknown:missing');
});

test('hidden/empty-graph-returns-empty-order', () => {
  assert.deepEqual(topologicalOrder([], []), []);
  assert.deepEqual(topologicalOrder(['solo'], []), ['solo']);
});
