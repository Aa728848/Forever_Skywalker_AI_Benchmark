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

/** 深层树：验证实现不因递归深度而改变语义，也验证上限按**出现位置**计数而非按唯一对象。 */
function chain(depth: number, idPrefix = 'n'): TreeNode {
  let node: TreeNode = { id: idPrefix + depth };
  for (let level = depth - 1; level >= 0; level -= 1) node = { id: idPrefix + level, children: [node] };
  return node;
}

test('hidden/leaf-defaults-and-empty-array-are-equivalent', () => {
  const withDefault: TreeNode = { id: 'root', children: [{ id: 'implicit' }, { id: 'explicit', children: [] }] };
  const withEmpty: TreeNode = { id: 'root', children: [{ id: 'implicit', children: [] }, { id: 'explicit', children: [] }] };
  const left = walkTree(withDefault);
  const right = walkTree(withEmpty);
  assert.deepEqual(left.leaves, ['implicit', 'explicit']);
  assert.deepEqual(left.visited, right.visited);
  assert.deepEqual(left.leaves, right.leaves);
  // 叶子顺序必须与 visited 顺序一致，而不是另行收集。
  const leafPositions = left.visited.filter(id => left.leaves.includes(id));
  assert.deepEqual(leafPositions, left.leaves);
});

test('hidden/limit-boundaries-are-exact', () => {
  const tree = chain(4);
  // 恰好等于上限：完整返回，不得抛错。
  assert.equal(walkTree(tree, { maxNodes: 5 }).visited.length, 5);
  // 上限 - 1：在将要越界时抛错，limit 字段回显实际上限。
  assert.equal(codeOf(() => walkTree(tree, { maxNodes: 4 })), 'limit:4');
  assert.equal(codeOf(() => walkTree(tree, { maxNodes: 1 })), 'limit:1');
  // 单节点 + maxNodes=1 是合法边界。
  assert.deepEqual(walkTree({ id: 'only' }, { maxNodes: 1 }).visited, ['only']);
});

test('hidden/limit-counts-occurrences-not-unique-objects', () => {
  const shared: TreeNode = { id: 'shared' };
  const tree: TreeNode = { id: 'root', children: [shared, { id: 'mid', children: [shared] }, shared] };
  // 5 个出现位置、3 个唯一对象：按唯一对象计数会错误通过。
  assert.deepEqual(walkTree(tree, { maxNodes: 5 }).visited, ['root', 'shared', 'mid', 'shared', 'shared']);
  assert.equal(codeOf(() => walkTree(tree, { maxNodes: 4 })), 'limit:4');
});

test('hidden/invalid-maxnodes-rejects-non-integers', () => {
  const tree = chain(2);
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => walkTree(tree, { maxNodes: value as number }), RangeError, 'maxNodes=' + String(value));
  }
});

test('hidden/cycle-path-points-at-repeated-occurrence', () => {
  const a: TreeNode = { id: 'a' };
  const b: TreeNode = { id: 'b', children: [a] };
  const c: TreeNode = { id: 'c', children: [b] };
  const root: TreeNode = { id: 'root', children: [c] };
  (a as { children?: readonly TreeNode[] }).children = [root];
  // path 必须指向**再次出现** root 的那个位置，不是首次出现的位置。
  assert.equal(codeOf(() => walkTree(root)), 'invalid:root.children[0].children[0].children[0].children[0]');
  // 同一对象出现在互不为祖先的两个分支仍然合法。
  const shared: TreeNode = { id: 's', children: [{ id: 's1' }] };
  const legal: TreeNode = { id: 'root', children: [shared, { id: 'other', children: [shared] }] };
  assert.deepEqual(walkTree(legal).visited, ['root', 's', 's1', 'other', 's', 's1']);
});

test('hidden/validates-lazily-and-does-not-mutate-input', () => {
  const bad: TreeNode = { id: 'root', children: [{ id: 'ok' }, { id: 'bad', children: 'nope' as unknown as readonly TreeNode[] }] };
  assert.equal(codeOf(() => walkTree(bad)), 'invalid:root.children[1].children');
  // 输入不得被写入：children 缺省/顺序/身份全部保持原样。
  const frozen: TreeNode = { id: 'f', children: [{ id: 'g' }] };
  const snapshot = JSON.stringify(frozen);
  walkTree(frozen);
  assert.equal(JSON.stringify(frozen), snapshot);
  const child = (frozen as { children?: readonly TreeNode[] }).children![0]!;
  assert.equal(child.id, 'g');
  // 重复调用结果一致（无隐藏状态残留）。
  assert.deepEqual(walkTree(frozen), walkTree(frozen));
});

test('hidden/deep-chain-terminates-without-truncating', () => {
  // 800 层 + 末端叶子：足以暴露栈溢出与截断，同时留在契约默认上限 10000 之内。
  // chain(800) 给出 n0→n1→…→n800 共 801 个节点，末端再挂一个真叶子。
  let deep: TreeNode = { id: 'tail' };
  for (let level = 800; level >= 0; level -= 1) deep = { id: 'n' + level, children: [deep] };
  const result = walkTree(deep);
  assert.equal(result.visited.length, 802);
  assert.equal(result.visited[0], 'n0');
  assert.equal(result.visited[800], 'n800');
  assert.equal(result.visited[801], 'tail');
  assert.deepEqual(result.leaves, ['tail']);
  // 上限在越过时抛错：显式上限下走满再越界，验证不是静默截断。
  let overlong: TreeNode = { id: 'z0' };
  for (let level = 1; level <= 60; level += 1) overlong = { id: 'z' + level, children: [overlong] };
  assert.deepEqual(walkTree(overlong, { maxNodes: 61 }).visited.length, 61);
  assert.equal(codeOf(() => walkTree(overlong, { maxNodes: 60 })), 'limit:60');
});
