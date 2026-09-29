import test from 'node:test';
import assert from 'node:assert/strict';
import { DuplicateProviderError, InvalidProviderError, resolveProviders, type Provider } from '../starter/src/providers.ts';

const provider = (id: string, runtime: 'shared' | 'browser' | 'node'): Provider =>
  ({ id, runtime, label: id.toUpperCase() });

const ids = (providers: readonly Provider[]): string[] => providers.map(p => p.id);

test('hidden/selection-ignores-naming-entirely', () => {
  // 契约第 1 条：只看 runtime 元数据，不看 id 命名。
  // 关键反例：带 browser- 前缀但 runtime 是 shared 的 provider，在 node 侧**必须可用**。
  const catalog = [
    provider('browser-fake', 'shared'),
    provider('no-prefix-node-only', 'node'),
    provider('no-prefix-browser-only', 'browser'),
    provider('random-name', 'shared'),
  ];
  const onNode = resolveProviders(catalog, 'node');
  assert.deepEqual(ids(onNode.usable), ['browser-fake', 'no-prefix-node-only', 'random-name'],
    'node 侧按 id 命名做了筛选');
  assert.deepEqual(onNode.skipped, ['no-prefix-browser-only']);

  const onBrowser = resolveProviders(catalog, 'browser');
  assert.deepEqual(ids(onBrowser.usable), ['browser-fake', 'no-prefix-browser-only', 'random-name'],
    'browser 侧按 id 命名做了筛选');
  assert.deepEqual(onBrowser.skipped, ['no-prefix-node-only']);

  // 前缀完全不能影响结果：同元数据换 id 结论不变。
  const renamed = [provider('zzz', 'shared'), provider('aaa', 'shared')];
  assert.deepEqual(ids(resolveProviders(renamed, 'node').usable), ['zzz', 'aaa']);
  // 名字像 browser 但元数据是 node：node 侧可用，browser 侧跳过。
  const misleading = [provider('browser-actually-node', 'node')];
  assert.deepEqual(ids(resolveProviders(misleading, 'node').usable), ['browser-actually-node']);
  assert.deepEqual(resolveProviders(misleading, 'browser').usable, []);
});

test('hidden/both-outputs-preserve-catalog-order', () => {
  // 契约第 2 条：usable 与 skipped 都保持目录中的原始相对顺序。
  const catalog = [
    provider('z-shared', 'shared'),
    provider('a-node', 'node'),
    provider('m-browser', 'browser'),
    provider('b-shared', 'shared'),
    provider('y-node', 'node'),
    provider('c-browser', 'browser'),
  ];
  for (const runtime of ['node', 'browser'] as const) {
    const result = resolveProviders(catalog, runtime);
    // usable 是 catalog 的子序列，且相对顺序不变。
    const expectedUsable = catalog.filter(p => p.runtime === 'shared' || p.runtime === runtime).map(p => p.id);
    assert.deepEqual(ids(result.usable), expectedUsable, runtime);
    const expectedSkipped = catalog.filter(p => !(p.runtime === 'shared' || p.runtime === runtime)).map(p => p.id);
    assert.deepEqual(result.skipped, expectedSkipped, runtime + ' skipped 顺序不对');
    // 两者合起来必须正好是原目录（不重不漏）。
    assert.deepEqual([...ids(result.usable), ...result.skipped].length, catalog.length);
  }
});

test('hidden/duplicate-id-is-rejected-regardless-of-runtime', () => {
  // 契约第 3 条：重复 id 抛 DuplicateProviderError。
  assert.throws(
    () => resolveProviders([provider('dup', 'node'), provider('dup', 'shared')], 'node'),
    (error: unknown) => error instanceof DuplicateProviderError && error.id === 'dup',
  );
  // runtime 不同也算重复。
  assert.throws(
    () => resolveProviders([provider('dup', 'node'), provider('dup', 'browser')], 'browser'),
    DuplicateProviderError,
  );
  // 三个同名也要报。
  assert.throws(
    () => resolveProviders([provider('x', 'node'), provider('x', 'node'), provider('x', 'shared')], 'node'),
    (error: unknown) => error instanceof DuplicateProviderError && error.id === 'x',
  );
  // 不重复时不得误报。
  assert.doesNotThrow(() => resolveProviders([provider('a', 'node'), provider('b', 'node')], 'node'));
});

test('hidden/invalid-metadata-is-rejected', () => {
  // 契约第 3 条：id 为空串或 runtime 非法抛 InvalidProviderError。
  assert.throws(
    () => resolveProviders([provider('', 'node')], 'node'),
    (error: unknown) => error instanceof InvalidProviderError && error.id === '',
  );
  // 非法 runtime 值。
  for (const runtime of ['edge', 'NODE', 'shared ', '', 'deno', 'unknown'] as unknown as Array<Provider['runtime']>) {
    assert.throws(
      () => resolveProviders([{ id: 'p', runtime, label: 'P' }], 'node'),
      (error: unknown) => error instanceof InvalidProviderError && error.id === 'p',
      'runtime=' + String(runtime),
    );
  }
  // 非字符串 id。
  for (const id of [undefined, null, 0, 1, {}, [], true] as unknown as Array<string>) {
    assert.throws(
      () => resolveProviders([{ id, runtime: 'node', label: 'P' }], 'node'),
      InvalidProviderError,
      'id=' + String(id),
    );
  }
  // 空串 id 与非法 runtime 同时出现时，仍应是 InvalidProviderError 而不是别的。
  assert.throws(
    () => resolveProviders([{ id: '', runtime: 'bogus' as Provider['runtime'], label: 'P' }], 'node'),
    InvalidProviderError,
  );
});

test('hidden/empty-and-single-element-catalogs', () => {
  // 契约第 4 条：空目录返回空结果。
  for (const runtime of ['node', 'browser'] as const) {
    assert.deepEqual(resolveProviders([], runtime), { usable: [], skipped: [] });
  }
  // 单元素：按元数据决定去留。
  assert.deepEqual(ids(resolveProviders([provider('only', 'node')], 'node').usable), ['only']);
  assert.deepEqual(resolveProviders([provider('only', 'node')], 'browser').skipped, ['only']);
  assert.deepEqual(ids(resolveProviders([provider('only', 'shared')], 'node').usable), ['only']);
  assert.deepEqual(ids(resolveProviders([provider('only', 'browser')], 'browser').usable), ['only']);
  // shared 在两个运行时的结果一致。
  assert.deepEqual(resolveProviders([provider('s', 'shared')], 'node'), resolveProviders([provider('s', 'shared')], 'browser'));
});

test('hidden/results-do-not-leak-or-mutate-the-catalog', () => {
  // 契约未要求每次返回新数组；这里只验证输入目录不被修改，
  // 且同一次输入的不同调用结果稳定。
  const catalog = [provider('a', 'node'), provider('b', 'browser')];
  const first = resolveProviders(catalog, 'node');
  const second = resolveProviders(catalog, 'node');
  assert.deepEqual(ids(first.usable), ['a']);
  assert.deepEqual(ids(second.usable), ['a']);
  assert.deepEqual(first.skipped, ['b']);
  assert.deepEqual(second.skipped, ['b']);
  // 输入目录必须原样保留。
  assert.equal(catalog.length, 2);
  assert.deepEqual(catalog.map(p => p.id), ['a', 'b']);
  assert.deepEqual(catalog.map(p => p.runtime), ['node', 'browser']);
  // 不同运行时的调用互不干扰。
  assert.deepEqual(ids(resolveProviders(catalog, 'browser').usable), ['b']);
  assert.deepEqual(ids(resolveProviders(catalog, 'node').usable), ['a']);
});

test('hidden/all-shared-catalog-goes-to-both-runtimes', () => {
  // 全部 shared 时，两个运行时都拿到全部 provider，且都不跳过。
  const catalog = [provider('s1', 'shared'), provider('s2', 'shared'), provider('s3', 'shared')];
  for (const runtime of ['node', 'browser'] as const) {
    const result = resolveProviders(catalog, runtime);
    assert.deepEqual(ids(result.usable), ['s1', 's2', 's3'], runtime);
    assert.deepEqual(result.skipped, [], runtime);
  }
  // 全部 node 时，browser 侧全部跳过。
  const nodeOnly = [provider('n1', 'node'), provider('n2', 'node')];
  assert.deepEqual(resolveProviders(nodeOnly, 'node').skipped, []);
  assert.deepEqual(resolveProviders(nodeOnly, 'browser').skipped, ['n1', 'n2']);
  assert.deepEqual(resolveProviders(nodeOnly, 'browser').usable, []);
});
