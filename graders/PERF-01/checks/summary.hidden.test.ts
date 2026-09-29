import test from 'node:test';
import assert from 'node:assert/strict';
import { InvalidLineError, parseLine, summarizeRecords } from '../starter/src/summary.ts';

/** 可计数的输入：记录每个元素被访问了几次。 */
function countingInput(lines: string[]): { proxy: string[]; reads: () => number } {
  let reads = 0;
  const proxy = new Proxy(lines, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  return { proxy, reads: () => reads };
}

test('hidden/access-count-stays-linear', () => {
  // 契约第 4 条：对输入数组的元素访问总次数必须是 O(n)，公开常数 ≤ 8n。
  // 关键反例：每个 key 重扫一遍会让访问次数变成 key 数 × n。
  for (const [keys, lines] of [[2, 60], [4, 80], [8, 120], [16, 160]] as Array<[number, number]>) {
    const source: string[] = [];
    for (let index = 0; index < lines; index += 1) {
      source.push('k' + (index % keys) + '=' + (index % 7));
    }
    const { proxy, reads } = countingInput(source);
    const result = summarizeRecords(proxy);
    assert.equal(Object.keys(result).length, keys, keys + ' 个 key 的结果不对');
    const count = reads();
    assert.ok(count <= 8 * source.length,
      keys + ' 个 key / ' + source.length + ' 行：访问 ' + count + ' 次，超过 8n=' + 8 * source.length);
  }
});

test('hidden/duplicate-lines-do-not-inflate-access-count', () => {
  // 契约第 5 条：相同内容的行不得让访问次数膨胀。
  const base: string[] = [];
  for (let index = 0; index < 50; index += 1) base.push('same=' + index);
  const first = countingInput(base);
  summarizeRecords(first.proxy);
  const once = first.reads();
  // 把同样的 50 行再拼 10 遍：n 变成 500，访问次数必须近似线性增长而不是爆炸。
  const repeated: string[] = [];
  for (let round = 0; round < 10; round += 1) repeated.push(...base);
  const second = countingInput(repeated);
  summarizeRecords(second.proxy);
  const many = second.reads();
  assert.ok(many <= 8 * repeated.length, '重复行让访问次数膨胀：' + many + ' > ' + 8 * repeated.length);
  // 增长幅度不应与重复轮数成正比的额外因子。
  assert.ok(many <= 10 * once + 8 * repeated.length, '访问次数随重复轮数异常增长');
});

test('hidden/empty-and-single-line-inputs', () => {
  // 契约第 3 条：空输入返回 {}。
  assert.deepEqual(summarizeRecords([]), {});
  assert.deepEqual(Object.getPrototypeOf(summarizeRecords([])), Object.prototype, '空结果原型不对');
  // 单行。
  assert.deepEqual(summarizeRecords(['k=1']), { k: 1 });
  assert.deepEqual(summarizeRecords(['k=0']), { k: 0 });
  assert.deepEqual(summarizeRecords(['k=-5']), { k: -5 });
  // 单 key 多行累加。
  assert.deepEqual(summarizeRecords(['k=1', 'k=2', 'k=3']), { k: 6 });
  // 累加到 0：键必须仍然存在（值为 0 不是缺失）。
  assert.deepEqual(summarizeRecords(['k=5', 'k=-5']), { k: 0 });
  assert.equal(Object.hasOwn(summarizeRecords(['k=5', 'k=-5']), 'k'), true, '累加为 0 的键丢失了');
});

test('hidden/parse-line-accepts-and-rejects-exactly', () => {
  // 契约第 1 条：key 非空且不含空白与 =；value 是可选负号的十进制整数。
  assert.deepEqual(parseLine('key=1'), { key: 'key', value: 1 });
  assert.deepEqual(parseLine('a=-1'), { key: 'a', value: -1 });
  assert.deepEqual(parseLine('a=0'), { key: 'a', value: 0 });
  assert.deepEqual(parseLine('_x.y-z=42'), { key: '_x.y-z', value: 42 });
  assert.deepEqual(parseLine('中文=7'), { key: '中文', value: 7 });
  // 非法形式。
  for (const bad of ['', '=', '=1', 'k=', 'k=+1', 'k=1.5', 'k=1e3', 'k= 1', 'k =1', 'a b=1', 'a=b=1', 'k=--1', 'k=1 ', ' k=1']) {
    assert.throws(() => parseLine(bad, 0), InvalidLineError, JSON.stringify(bad));
  }
  // 显式 index 会被带进错误。
  assert.throws(() => parseLine('bad', 7), (error: unknown) => error instanceof InvalidLineError && error.index === 7);
  // 缺省 index 为 0。
  assert.throws(() => parseLine('bad'), (error: unknown) => error instanceof InvalidLineError && error.index === 0);
});

test('hidden/summarize-reports-the-offending-line-index', () => {
  // 契约第 2 条：InvalidLineError 的 index 指向该行在输入中的下标。
  assert.throws(() => summarizeRecords(['a=1', 'b=2', 'bad', 'c=3']),
    (error: unknown) => error instanceof InvalidLineError && error.index === 2,
  );
  assert.throws(() => summarizeRecords(['bad']),
    (error: unknown) => error instanceof InvalidLineError && error.index === 0);
  assert.throws(() => summarizeRecords(['a=1', 'b=2', 'c=3', 'also-bad']),
    (error: unknown) => error instanceof InvalidLineError && error.index === 3);
  // 首行非法时 index 是 0。
  assert.throws(() => summarizeRecords(['', 'a=1']),
    (error: unknown) => error instanceof InvalidLineError && error.index === 0);
});

test('hidden/input-is-never-mutated-and-calls-are-repeatable', () => {
  // 契约第 5 条：不得修改输入；同一输入重复调用结果一致。
  const lines: string[] = ['a=1', 'b=2', 'a=3', 'c=-4'];
  const snapshot = JSON.stringify(lines);
  const frozenCopy = lines.slice();
  const first = summarizeRecords(lines);
  const second = summarizeRecords(lines);
  assert.deepEqual(first, second, '重复调用结果不一致');
  assert.deepEqual(first, { a: 4, b: 2, c: -4 });
  assert.equal(JSON.stringify(lines), snapshot, '输入被修改了');
  assert.deepEqual(lines, frozenCopy, '输入数组被改动了');
  assert.equal(lines.length, 4);
  // 结果不得是输入的引用。
  assert.notEqual(first as unknown, lines as unknown);
  // 返回普通对象。
  assert.equal(Object.getPrototypeOf(first), Object.prototype, '结果原型不是 Object.prototype');
  assert.equal(Object.hasOwn(first, 'a'), true);
});

test('hidden/matches-a-naive-single-pass-reference', () => {
  // 结果正确性：与朴素单遍实现逐项一致（含负数、零值、原型名键）。
  const lines: string[] = [
    'alpha=1', 'beta=-2', 'alpha=3', '__proto__=5', 'toString=7', 'constructor=11',
    'gamma=0', 'alpha=-1', 'beta=0', '__proto__=-5', 'delta=100', 'delta=-100',
  ];
  // 朴素参考必须用 null 原型对象：{} 字面量上赋值 '__proto__' 不会创建自有属性。
  const naive = Object.create(null) as Record<string, number>;
  for (const line of lines) {
    const parsed = parseLine(line);
    naive[parsed.key] = (naive[parsed.key] ?? 0) + parsed.value;
  }
  const actual = summarizeRecords(lines);
  // 逐键比较：naive 是 null 原型对象，与实际结果的 Object.prototype 不能用 deepEqual 直接比。
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(naive).sort(), '键集合不一致');
  for (const key of Object.keys(naive)) {
    assert.equal(actual[key], naive[key], '键 ' + key + ' 的值不一致');
  }
  // 累加为 0 的键仍然存在。
  assert.equal(Object.hasOwn(actual, 'gamma'), true, '值为 0 的键丢失了');
  assert.equal(Object.hasOwn(actual, 'delta'), true, '正负抵消的键丢失了');
  assert.equal(actual.delta, 0);
  // 结果仍是普通对象，原型名键作为普通数据。
  assert.equal(Object.getPrototypeOf(actual), Object.prototype);
  assert.equal(actual.__proto__, 0, '__proto__ 键没有作为普通数据处理');
});
