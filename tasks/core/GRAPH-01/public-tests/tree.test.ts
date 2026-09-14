import test from 'node:test';
import assert from 'node:assert/strict';
import { InvalidTreeError, NodeLimitExceededError, walkTree, type TreeNode } from '../starter/src/tree.ts';

function codeOf(run: () => unknown) {
  try { run(); return null; } catch (error) {
    if (error instanceof NodeLimitExceededError) return 'limit:' + error.limit;
    if (error instanceof InvalidTreeError) return 'invalid:' + error.path;
    return 'unexpected:' + String(error);
  }
}

test('public/walks-preorder-and-collects-leaves', () => {
  const tree: TreeNode = { id: 'root', children: [
    { id: 'a', children: [{ id: 'a1' }, { id: 'a2', children: [] }] },
    { id: 'b' },
  ] };
  const result = walkTree(tree);
  assert.deepEqual(result.visited, ['root', 'a', 'a1', 'a2', 'b']);
  assert.deepEqual(result.leaves, ['a1', 'a2', 'b']);
});

test('public/node-limit-is-enforced', () => {
  const tree: TreeNode = { id: 'r', children: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
  assert.equal(codeOf(() => walkTree(tree, { maxNodes: 3 })), 'limit:3');
  assert.deepEqual(walkTree(tree, { maxNodes: 4 }).visited, ['r', 'a', 'b', 'c']);
});

test('public/rejects-malformed-nodes', () => {
  assert.equal(codeOf(() => walkTree(null as unknown as TreeNode)), 'invalid:root');
  assert.equal(codeOf(() => walkTree({ id: 'r', children: 'x' } as unknown as TreeNode)), 'invalid:r.children'.replace('r', 'root'));
  assert.equal(codeOf(() => walkTree({ id: 'r', children: [null] } as unknown as TreeNode)), 'invalid:root.children[0]');
});

test('public/cycle-is-rejected', () => {
  const a: TreeNode = { id: 'a' };
  const b: TreeNode = { id: 'b', children: [a] };
  const root: TreeNode = { id: 'root', children: [b] };
  (a as { children?: readonly TreeNode[] }).children = [root];
  assert.equal(codeOf(() => walkTree(root)), 'invalid:root.children[0].children[0].children[0]');
});

test('public/shared-node-is-visited-per-occurrence', () => {
  const shared: TreeNode = { id: 'shared' };
  const tree: TreeNode = { id: 'root', children: [shared, shared] };
  assert.deepEqual(walkTree(tree).visited, ['root', 'shared', 'shared']);
});
