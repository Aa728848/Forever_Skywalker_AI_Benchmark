import test from 'node:test';
import assert from 'node:assert/strict';
import { DepthExceededError, InvalidNodeError, flattenPreOrder, maxDepth, walkPostOrder, type AstNode } from '../starter/src/ast.ts';

/** 深链：n0 为根，n(depth-1) 为最深的叶子。构造过程本身必须是迭代的。 */
function chain(depth: number): AstNode {
  let node: AstNode = { type: 'n' + (depth - 1) };
  for (let index = depth - 2; index >= 0; index -= 1) node = { type: 'n' + index, children: [node] };
  return node;
}

function sampleTree(): AstNode {
  return {
    type: 'root',
    children: [
      { type: 'a', children: [{ type: 'a1' }, { type: 'a2' }] },
      { type: 'b' },
      { type: 'c', children: [{ type: 'c1', children: [{ type: 'c11' }] }] },
    ],
  };
}

function postOrderReference(node: AstNode, path: string): string[] {
  const children = node.children ?? [];
  const types: string[] = [];
  for (let index = 0; index < children.length; index += 1) types.push(...postOrderReference(children[index] as AstNode, path + '.children[' + index + ']'));
  types.push(node.type);
  return types;
}

function preOrderReference(node: AstNode): string[] {
  const types = [node.type];
  for (const child of node.children ?? []) types.push(...preOrderReference(child));
  return types;
}

test('public/postorder-visits-children-first', () => {
  const visited: string[] = [];
  const count = walkPostOrder(sampleTree(), node => { visited.push(node.type); });
  assert.equal(count, 8);
  assert.deepEqual(visited, ['a1', 'a2', 'a', 'b', 'c11', 'c1', 'c', 'root']);
  assert.deepEqual(visited, postOrderReference(sampleTree(), 'root'));
});

test('public/preorder-matches-recursive-reference', () => {
  const tree = sampleTree();
  assert.deepEqual(flattenPreOrder(tree), preOrderReference(tree));
});

test('public/does-not-overflow-on-deep-input', () => {
  const root = chain(200000);
  const visited: string[] = [];
  const count = walkPostOrder(root, node => { visited.push(node.type); });
  assert.equal(count, 200000);
  assert.equal(visited[0], 'n199999');
  assert.equal(visited[199999], 'n0');
  assert.equal(flattenPreOrder(root).length, 200000);
});

test('public/max-depth-honours-limit', () => {
  const shallow = { type: 'root', children: [{ type: 'a', children: [{ type: 'b', children: [{ type: 'c' }] }] }] };
  assert.equal(maxDepth(shallow, 4), 4);
  assert.throws(() => maxDepth(shallow, 3), DepthExceededError);
  assert.throws(() => maxDepth(shallow, 3), (error: unknown) => error instanceof DepthExceededError && error.limit === 3);
});

test('public/rejects-malformed-nodes', () => {
  assert.throws(() => walkPostOrder(null as unknown as AstNode, () => {}), InvalidNodeError);
  assert.throws(() => maxDepth({ type: 'root', children: 'no' } as unknown as AstNode, 5), InvalidNodeError);
  assert.throws(() => flattenPreOrder({ type: 'root', children: [1 as unknown as AstNode] }), InvalidNodeError);
});

test('public/repeated-walks-are-deterministic', () => {
  const tree = sampleTree();
  const first: string[] = [];
  walkPostOrder(tree, node => { first.push(node.type); });
  const second: string[] = [];
  walkPostOrder(tree, node => { second.push(node.type); });
  assert.deepEqual(second, first);
  assert.deepEqual(flattenPreOrder(tree), preOrderReference(tree));
});
