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

test('hidden/deep-chain-postorder-matches-differential', () => {
  const root = chain(200000);
  const visited: string[] = [];
  assert.equal(walkPostOrder(root, node => { visited.push(node.type); }), 200000);
  const expected: string[] = [];
  for (let index = 199999; index >= 0; index -= 1) expected.push('n' + index);
  assert.deepEqual(visited, expected);
});

test('hidden/deep-chain-preorder-order', () => {
  const types = flattenPreOrder(chain(120000));
  assert.equal(types.length, 120000);
  assert.equal(types[0], 'n0');
  assert.equal(types[119999], 'n119999');
});

test('hidden/max-depth-large-tree-limit', () => {
  assert.throws(() => maxDepth(chain(50000), 100), (error: unknown) => error instanceof DepthExceededError && error.limit === 100);
  assert.equal(maxDepth(chain(50000), 50000), 50000);
});

test('hidden/wide-fanout-within-budget', () => {
  const children: AstNode[] = [];
  for (let index = 0; index < 100000; index += 1) children.push({ type: 'leaf' + index });
  const visited: string[] = [];
  assert.equal(walkPostOrder({ type: 'root', children }, node => { visited.push(node.type); }), 100001);
  assert.equal(visited[0], 'leaf0');
  assert.equal(visited[100000], 'root');
});

test('hidden/malformed-paths-are-precise', () => {
  const broken = { type: 'root', children: [{ type: 'a' }, { type: 'b', children: [null] }] };
  assert.throws(() => walkPostOrder(broken as unknown as AstNode, () => {}), (error: unknown) => error instanceof InvalidNodeError && error.path === 'root.children[1].children[0]');
  assert.throws(() => walkPostOrder({ type: 'root', children: 5 } as unknown as AstNode, () => {}), (error: unknown) => error instanceof InvalidNodeError && error.path === 'root.children');
});

test('hidden/empty-children-equals-missing', () => {
  const withEmpty = { type: 'root', children: [] as AstNode[] };
  const without = { type: 'root' as const } as AstNode;
  assert.equal(walkPostOrder(withEmpty, () => {}), 1);
  assert.equal(walkPostOrder(without, () => {}), 1);
  assert.deepEqual(flattenPreOrder(withEmpty), flattenPreOrder(without));
  assert.equal(maxDepth(withEmpty, 1), 1);
  assert.equal(maxDepth(without, 1), 1);
});
