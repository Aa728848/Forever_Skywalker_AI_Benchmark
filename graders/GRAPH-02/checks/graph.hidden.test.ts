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

test('hidden/order-is-invariant-under-node-and-edge-permutation', () => {
  // 契约第 2 条：同一张图的任何输入排列都给出同一个序列。
  const nodes = ['e', 'a', 'd', 'b', 'c'];
  const edges = [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')];
  const canonical = topologicalOrder(nodes, edges);
  assert.deepEqual(canonical, ['a', 'b', 'c', 'd', 'e']);
  // 节点顺序的各种排列都必须得到同一结果。
  const permutations: string[][] = [
    ['e', 'a', 'd', 'b', 'c'], ['c', 'b', 'a', 'd', 'e'], ['d', 'c', 'b', 'a', 'e'],
    ['b', 'a', 'e', 'd', 'c'], ['a', 'b', 'c', 'd', 'e'],
  ];
  for (const order of permutations) {
    assert.deepEqual(topologicalOrder(order, edges), canonical, '节点顺序 ' + order.join('') + ' 改变了结果');
  }
  // 边顺序的各种排列同样不得改变结果。
  const edgePermutations: Edge[][] = [
    edges, [edges[3]!, edges[1]!, edges[0]!, edges[2]!], [edges[2]!, edges[0]!, edges[3]!, edges[1]!],
  ];
  for (const list of edgePermutations) {
    assert.deepEqual(topologicalOrder(nodes, list), canonical, '边顺序改变了结果');
  }
  // 节点与边同时打乱。
  assert.deepEqual(topologicalOrder(['d', 'e', 'c', 'b', 'a'], [edges[2]!, edges[0]!, edges[3]!, edges[1]!]), canonical);
});

test('hidden/duplicate-nodes-and-edges-do-not-block-progress', () => {
  // 契约第 1 条：重复节点只算一个；同一条边多次出现只算一次入度。
  assert.deepEqual(topologicalOrder(['a', 'a', 'b', 'a'], [edge('a', 'b')]), ['a', 'b']);
  assert.deepEqual(topologicalOrder(['a', 'b', 'b'], [edge('a', 'b'), edge('a', 'b'), edge('a', 'b')]), ['a', 'b']);
  // 混合重复：若重复边被重复计入入度，b 永远降不到 0，会误报成环。
  const mixed: Edge[] = [edge('a', 'b'), edge('a', 'b'), edge('b', 'c'), edge('b', 'c'), edge('c', 'd')];
  assert.deepEqual(topologicalOrder(['a', 'b', 'c', 'd'], mixed), ['a', 'b', 'c', 'd']);
  // 自环重复也只算一条，但仍构成环。
  assert.equal(failureOf(() => topologicalOrder(['a', 'a'], [edge('a', 'a'), edge('a', 'a')])), 'cycle:a>a');
});

test('hidden/self-loop-is-a-two-element-cycle', () => {
  // 契约第 3 条：自环的 path 是 [id, id]。
  const failure = failureOf(() => topologicalOrder(['a', 'b'], [edge('a', 'a')]));
  assert.equal(failure, 'cycle:a>a', '自环路径不对：' + failure);
  // 多个自环时，字典序小的应被选中（结果与输入顺序无关）。
  const two = failureOf(() => topologicalOrder(['z', 'a'], [edge('z', 'z'), edge('a', 'a')]));
  assert.equal(two, 'cycle:a>a', '多个自环时选择不确定：' + two);
});

test('hidden/cycle-path-contains-only-the-cycle-itself', () => {
  // 契约第 3 条 + 末段：路径只含闭环，不含进入环的前缀或环后的下游。
  // x -> a -> b -> a，且 c 在 a 之后：环里不能出现 x 或 c。
  const edges = [edge('x', 'a'), edge('a', 'b'), edge('b', 'a'), edge('a', 'c')];
  for (const nodes of [['x', 'a', 'b', 'c'], ['c', 'b', 'a', 'x'], ['b', 'x', 'c', 'a']]) {
    const failure = failureOf(() => topologicalOrder(nodes, edges));
    assert.ok(failure.startsWith('cycle:'), '必须报环：' + failure);
    const path = failure.slice('cycle:'.length).split('>');
    // 首尾相同、长度 ≥2、只含 a 与 b。
    assert.equal(path[0], path[path.length - 1], '环路径首尾不同：' + failure);
    assert.ok(path.length >= 2, '环路径过短：' + failure);
    assert.deepEqual([...new Set(path)].sort(), ['a', 'b'], '环里混入了非环节点：' + failure);
    // 每一对相邻节点都必须对应真实边。
    for (let i = 0; i < path.length - 1; i += 1) {
      assert.equal(edges.some(e => e.from === path[i] && e.to === path[i + 1]), true,
        path[i] + '→' + path[i + 1] + ' 不是真实边');
    }
  }
});

test('hidden/cycle-detection-is-order-invariant', () => {
  // 契约第 3 条：环的发现结果也必须与输入顺序无关。
  const nodes = ['n1', 'n2', 'n3', 'n4'];
  const edges = [edge('n1', 'n2'), edge('n2', 'n3'), edge('n3', 'n1'), edge('n3', 'n4')];
  const arrangements: Array<[string[], Edge[]]> = [
    [nodes, edges],
    [['n4', 'n3', 'n2', 'n1'], [edges[2]!, edges[0]!, edges[3]!, edges[1]!]],
    [['n2', 'n4', 'n1', 'n3'], [edges[1]!, edges[3]!, edges[2]!, edges[0]!]],
  ];
  const results = arrangements.map(([order, list]) => failureOf(() => topologicalOrder(order, list)));
  for (const result of results) {
    assert.ok(result.startsWith('cycle:'), '必须报环：' + result);
  }
  assert.equal(new Set(results).size, 1, '不同输入顺序给出了不同的环：' + results.join(' / '));
});

test('hidden/unknown-node-edges-are-rejected', () => {
  // 契约第 4 条：边引用未声明节点抛 UnknownNodeError。
  assert.equal(failureOf(() => topologicalOrder(['a'], [edge('a', 'missing')])), 'unknown:missing');
  assert.equal(failureOf(() => topologicalOrder(['a'], [edge('missing', 'a')])), 'unknown:missing');
  // 两个都未声明时，报哪一个必须稳定。
  const both = failureOf(() => topologicalOrder(['a'], [edge('x', 'y')]));
  assert.ok(both === 'unknown:x' || both === 'unknown:y', '报了意外节点：' + both);
  // 合法边不应误报。
  assert.deepEqual(topologicalOrder(['a', 'b'], [edge('a', 'b')]), ['a', 'b']);
});

test('hidden/isolated-nodes-sort-lexicographically-among-themselves', () => {
  // 契约第 2 条：可选节点之间按字典序。
  assert.deepEqual(topologicalOrder(['z', 'y', 'x'], []), ['x', 'y', 'z']);
  assert.deepEqual(topologicalOrder(['b', 'a', 'd', 'c'], [edge('a', 'b')]), ['a', 'b', 'c', 'd']);
  // 字典序按 JavaScript 默认字符串比较（不是 localeCompare）。
  assert.deepEqual(topologicalOrder(['B', 'a', 'A'], []), ['A', 'B', 'a'], '大写字母的序不对');
  assert.deepEqual(topologicalOrder(['10', '9', '2'], []), ['10', '2', '9'], '数字字符串用了数值序');
  // 依赖必须先于其后继，即便后继字典序更小。
  assert.deepEqual(topologicalOrder(['a', 'zzz'], [edge('a', 'zzz')]), ['a', 'zzz']);
  assert.deepEqual(topologicalOrder(['zzz', 'a'], [edge('a', 'zzz')]), ['a', 'zzz']);
});
