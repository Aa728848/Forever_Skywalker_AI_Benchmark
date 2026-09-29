import test from 'node:test';
import assert from 'node:assert/strict';
import { IncompleteSequenceError, InvalidUtf8Error, StreamDecoder } from '../starter/src/decoder.ts';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

test('hidden/every-cut-point-decodes-identically', () => {
  // 契约第 1、2 条：跨块边界对 2、3、4 字节字符都成立，且 push 只返回本次新增的完整字符。
  // 关键反例：任何切分点都不得产生替换字符，也不得提前或滞后输出。
  const text = 'a中b🚀c文d';
  const encoded = bytes(text);
  for (let cut = 0; cut <= encoded.length; cut += 1) {
    const decoder = new StreamDecoder();
    const first = decoder.push(encoded.subarray(0, cut));
    const second = decoder.push(encoded.subarray(cut));
    const tail = decoder.end();
    assert.equal(first + second + tail, text, '切分点 ' + cut + ' 解码结果不一致');
    assert.equal(first.includes('\uFFFD'), false, '切分点 ' + cut + ' 产生了替换字符');
    assert.equal(decoder.offset, encoded.length, '切分点 ' + cut + ' offset 不对');
  }
  // 逐字节推送也必须一致。
  const single = new StreamDecoder();
  let collected = '';
  for (const byte of encoded) collected += single.push(Uint8Array.of(byte));
  collected += single.end();
  assert.equal(collected, text, '逐字节推送解码不一致');
});

test('hidden/push-returns-only-newly-completed-characters', () => {
  // 契约第 1 条：末尾未完成的多字节序列必须保留到下一次 push，
  // 不得解码、不得报错、不得产出替换字符。
  const encoded = bytes('中');
  assert.equal(encoded.length, 3);
  const decoder = new StreamDecoder();
  // 前两个字节：不完整，返回空串且不报错。
  assert.equal(decoder.push(encoded.subarray(0, 1)), '');
  assert.equal(decoder.push(encoded.subarray(1, 2)), '');
  assert.equal(decoder.offset, 2, '未完成序列也必须计入 offset');
  // 最后一个字节到达时才产出完整字符。
  assert.equal(decoder.push(encoded.subarray(2, 3)), '中');
  assert.equal(decoder.end(), '');
  assert.equal(decoder.offset, 3);

  // 四字节 emoji 同理：前三字节静默等待。
  const rocket = bytes('🚀');
  const other = new StreamDecoder();
  assert.equal(other.push(rocket.subarray(0, 3)), '');
  assert.equal(other.push(rocket.subarray(3, 4)), '🚀');
});

test('hidden/invalid-sequence-reports-global-start-offset', () => {
  // 契约第 3 条：offset 是该序列在整条流中的起始字节偏移。
  const decoder = new StreamDecoder();
  decoder.push(bytes('prefix'));            // 6 字节
  assert.equal(decoder.offset, 6);
  // 非法首字节 0xff。
  assert.throws(() => decoder.push(Uint8Array.of(0xff)),
    (error: unknown) => error instanceof InvalidUtf8Error && error.offset === 6,
  );
  // 换一个新 decoder：跨块的不完整前缀也算序列起点。
  const across = new StreamDecoder();
  across.push(bytes('ab'));                 // 2 字节
  assert.equal(across.push(Uint8Array.of(0xe2)), '');  // 3 字节字符的首字节
  assert.equal(across.offset, 3);
  // 下一个字节不是合法续字节：序列起点是 0xe2 所在位置。
  assert.throws(() => across.push(Uint8Array.of(0x28)),
    (error: unknown) => error instanceof InvalidUtf8Error && error.offset === 2,
  );
});

test('hidden/end-rejects-incomplete-and-locks-the-stream', () => {
  // 契约第 4 条：end() 有残序列时抛 IncompleteSequenceError；end 之后再 push 也抛。
  const encoder = bytes('中');
  const decoder = new StreamDecoder();
  decoder.push(encoder.subarray(0, 2));     // 留一个残字节
  assert.equal(decoder.end === undefined, false);
  assert.throws(() => decoder.end(), IncompleteSequenceError);
  // end 失败后进入永久错误态：再 push 同样抛。
  assert.throws(() => decoder.push(encoder.subarray(2, 3)), IncompleteSequenceError);
  assert.throws(() => decoder.end(), IncompleteSequenceError);

  // end 成功后再 push 也必须抛。
  const ok = new StreamDecoder();
  ok.push(bytes('done'));
  assert.equal(ok.end(), '');
  assert.throws(() => ok.push(bytes('more')), IncompleteSequenceError);
});

test('hidden/empty-and-ascii-only-pushes', () => {
  // 空块不产出内容、也不改变 offset；纯 ASCII 直接返回。
  const decoder = new StreamDecoder();
  assert.equal(decoder.push(new Uint8Array()), '');
  assert.equal(decoder.offset, 0);
  assert.equal(decoder.push(bytes('plain ascii')), 'plain ascii');
  assert.equal(decoder.offset, 11);
  assert.equal(decoder.push(new Uint8Array()), '');
  assert.equal(decoder.offset, 11);
  // 多个空块后仍可正常解码多字节字符。
  assert.equal(decoder.push(new Uint8Array()), '');
  assert.equal(decoder.push(bytes('中')), '中');
  assert.equal(decoder.offset, 14);
  // end 成功后流进入终态：再 push 抛 IncompleteSequenceError（契约第 4 条）。
  assert.equal(decoder.end(), '');
  assert.throws(() => decoder.push(bytes('more')), IncompleteSequenceError);
  // 重复 end 返回空串。
  assert.equal(decoder.end(), '');
  assert.equal(decoder.end(), '');
  assert.equal(decoder.offset, 14);
});

test('hidden/offset-counts-all-received-bytes', () => {
  // 契约第 5 条：offset 是已接收的字节总数。
  const decoder = new StreamDecoder();
  assert.equal(decoder.offset, 0);
  decoder.push(bytes('abc'));        // 3
  assert.equal(decoder.offset, 3);
  decoder.push(bytes('中文'));        // 6
  assert.equal(decoder.offset, 9);
  // 未完成序列的字节也计入。
  const rocket = bytes('🚀');
  decoder.push(rocket.subarray(0, 2));
  assert.equal(decoder.offset, 11);
  decoder.push(rocket.subarray(2, 4));
  assert.equal(decoder.offset, 13);
  assert.equal(decoder.end(), '');
  // end 不改变 offset。
  assert.equal(decoder.offset, 13);
});

test('hidden/caller-buffer-is-not-mutated-or-retained', () => {
  // 契约第 5 条：不得修改调用方传入的 Uint8Array。
  // 若实现借用调用方缓冲保留残字节，下面改写后会解码出错。
  const encoded = bytes('中');
  const head = encoded.slice(0, 1);
  const tail = encoded.slice(1, 3);
  const headSnapshot = Array.from(head);
  const tailSnapshot = Array.from(tail);
  const decoder = new StreamDecoder();
  assert.equal(decoder.push(head), '');
  assert.equal(decoder.push(tail), '中');
  // push 不得改写调用方的两个数组。
  assert.deepEqual(Array.from(head), headSnapshot, 'push 改写了调用方数组');
  assert.deepEqual(Array.from(tail), tailSnapshot, 'push 改写了调用方数组');

  // 借用检测：先推首字节，再改写它，再推剩余字节。
  const borrowed = new StreamDecoder();
  const single = encoded.slice(0, 1);
  assert.equal(borrowed.push(single), '');
  single[0] = 0xff;
  assert.equal(borrowed.push(encoded.slice(1, 3)), '中', '实现借用了调用方缓冲');
  assert.equal(borrowed.offset, 3);
});

test('hidden/two-three-and-four-byte-boundaries', () => {
  // 契约第 2 条：明确覆盖 2、3、4 字节三类字符的跨块边界。
  const cases: Array<[string, number]> = [['é', 2], ['中', 3], ['🚀', 4]];
  for (const [char, length] of cases) {
    const encoded = bytes(char);
    assert.equal(encoded.length, length, char + ' 的 UTF-8 长度不是 ' + length);
    // 在每一个字节边界切开，都必须还原出同一个字符。
    for (let cut = 1; cut < length; cut += 1) {
      const decoder = new StreamDecoder();
      const before = decoder.push(encoded.subarray(0, cut));
      const after = decoder.push(encoded.subarray(cut, length));
      assert.equal(before, '', char + ' 在 ' + cut + ' 处提前产出了内容');
      assert.equal(after, char, char + ' 在 ' + cut + ' 处解码失败');
      assert.equal(decoder.offset, length);
      assert.equal(decoder.end(), '');
    }
  }
});
