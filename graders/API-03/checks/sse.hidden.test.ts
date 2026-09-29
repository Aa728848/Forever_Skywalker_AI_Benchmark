import test from 'node:test';
import assert from 'node:assert/strict';
import { MalformedFrameError, SequenceGapError, SseDecoder } from '../starter/src/sse.ts';

const frame = (id: number, data: string): string => 'id: ' + id + '\ndata: ' + data + '\n\n';

function idsOf(events: readonly { id: number }[]): number[] {
  return events.map(event => event.id);
}

test('hidden/frames-parse-across-arbitrary-chunk-boundaries', () => {
  // 契约第 2 条：不完整的帧必须缓存到后续块，不得提前解析或丢弃。
  const whole = frame(1, 'alpha') + frame(2, 'beta') + frame(3, 'gamma');
  // 逐字符喂入：任何切分点都不得丢帧或提前投递。
  for (let at = 1; at < whole.length; at += 1) {
    const decoder = new SseDecoder();
    const first = decoder.push(whole.slice(0, at));
    const second = decoder.push(whole.slice(at));
    assert.deepEqual([...idsOf(first), ...idsOf(second)], [1, 2, 3],
      '切分点 ' + at + ' 丢失或重复了事件');
  }
  // 一个字符一个字符也不丢。
  const decoder = new SseDecoder();
  const collected: number[] = [];
  for (const char of whole) collected.push(...idsOf(decoder.push(char)));
  assert.deepEqual(collected, [1, 2, 3], '逐字符喂入丢失了事件');
  assert.equal(decoder.lastId, 3);
});

test('hidden/sequence-gap-reports-expected-and-received', () => {
  // 契约第 3 条：跳跃抛 SequenceGapError，且失败不得推进 lastId。
  const decoder = new SseDecoder();
  assert.deepEqual(idsOf(decoder.push(frame(1, 'a'))), [1]);
  assert.equal(decoder.lastId, 1);
  assert.throws(() => decoder.push(frame(5, 'e')), (error: unknown) =>
    error instanceof SequenceGapError && error.expected === 2 && error.received === 5,
  );
  // 失败不得推进 lastId。
  assert.equal(decoder.lastId, 1, '失败后 lastId 被推进了');
  // 回到连续序列后可以继续。
  assert.deepEqual(idsOf(decoder.push(frame(2, 'b'))), [2]);
  assert.equal(decoder.lastId, 2);
});

test('hidden/replayed-events-are-ignored-not-delivered', () => {
  // 契约第 4 条：id 不大于 lastId 的一律忽略，随后更大的 id 仍按连续性处理。
  const decoder = new SseDecoder();
  decoder.push(frame(1, 'a'));
  decoder.push(frame(2, 'b'));
  // 完全相同的 id。
  assert.deepEqual(idsOf(decoder.push(frame(2, 'again'))), [], '重放的 id 被投递了');
  // 更旧的 id。
  assert.deepEqual(idsOf(decoder.push(frame(1, 'old'))), [], '更旧的 id 被投递了');
  assert.equal(decoder.lastId, 2, '重放推进了 lastId');
  // 随后更大的 id 仍按连续性处理。
  assert.deepEqual(idsOf(decoder.push(frame(3, 'c'))), [3]);
  assert.equal(decoder.lastId, 3);
  // 连续多个重放也不得投递。
  assert.deepEqual(idsOf(decoder.push(frame(3, 'x') + frame(2, 'y') + frame(1, 'z'))), []);
  assert.equal(decoder.lastId, 3);
});

test('hidden/end-flushes-trailing-frame-and-handles-empty-buffer', () => {
  // 契约第 5 条：end() 处理缓冲区里最后一个不完整帧；空缓冲返回空数组。
  const decoder = new SseDecoder();
  assert.deepEqual(decoder.end(), [], '空缓冲的 end 返回了非空');
  // 完整帧在 push 时已投递，end 不再重复。
  decoder.push(frame(1, 'a'));
  assert.deepEqual(decoder.end(), [], 'end 重复投递了已完成的帧');
  // 没有结尾空行的帧由 end 收尾。
  const trailing = new SseDecoder();
  assert.deepEqual(idsOf(trailing.push('id: 1\ndata: a')), [], '未闭合帧被提前投递');
  assert.deepEqual(idsOf(trailing.end()), [1], 'end 没有收尾未闭合帧');
  // 帧之间必须恰好由一个空行分隔；连续空行会产生空帧并按契约第 1 条报格式错误。
  // 这里只验证 end 在缓冲为空或只有空白时返回空数组（契约第 5 条）。
  const empty = new SseDecoder();
  assert.deepEqual(empty.end(), [], '空缓冲的 end 返回了非空');
  // 完整帧的结尾空行已被 push 消费，缓冲为空。
  const consumed = new SseDecoder();
  consumed.push(frame(1, 'a'));
  assert.deepEqual(consumed.end(), [], 'end 重复投递了已完成的帧');
  // 直接喂空白（不构成完整帧）后再 end。
  const spaces = new SseDecoder();
  spaces.push('   ');
  assert.deepEqual(spaces.end(), []);
});

test('hidden/malformed-frames-report-the-offending-text', () => {
  // 契约第 1 条：字段缺失抛 MalformedFrameError，frame 是出错的帧文本。
  const cases = [
    'data: no-id\n\n',
    'id: 1\n\n',
    'id: -1\ndata: negative\n\n',
    'id: 1.5\ndata: float\n\n',
    'id: abc\ndata: text\n\n',
    'id: \ndata: empty-id\n\n',
  ];
  for (const raw of cases) {
    const decoder = new SseDecoder();
    assert.throws(() => decoder.push(raw), (error: unknown) =>
      error instanceof MalformedFrameError && typeof error.frame === 'string' && error.frame.length > 0,
    'frame=' + JSON.stringify(raw));
  }
  // 注意：lastId 初值为 0，契约第 4 条「id 不大于 lastId 一律忽略」意味着
  // id: 0 从一开始就被视为重放。这不是格式错误，因此不抛 MalformedFrameError。
  const zero = new SseDecoder();
  assert.deepEqual(idsOf(zero.push(frame(0, 'start'))), [], 'id=0 被投递了');
  assert.equal(zero.lastId, 0);
  // id: 0 的格式本身合法（不抛错），随后 id: 1 正常投递。
  assert.deepEqual(idsOf(zero.push(frame(1, 'next'))), [1]);
  // end 时才发现的残缺帧同样要报。
  const trailing = new SseDecoder();
  trailing.push('id: 1\n');
  assert.throws(() => trailing.end(), MalformedFrameError);
});

test('hidden/data-preserves-exact-content', () => {
  // data 内容必须原样保留：空格、冒号、换行标记、中文与 emoji。
  // 注意：data: 与值之间的分隔空白由帧格式吸收（前导空格不保留），
  // 这是既定解析规则；这里验证的是内容原样保留，不验证前导空白语义。
  const samples = ['a', 'spaced ', 'has: colon', 'multi word data', '中文内容', '🎯 emoji', '', '0', '-1', 'a  b  c'];
  for (const value of samples) {
    // 每个样本用独立 decoder：id 固定为 1，避免跨样本累积成序列跳跃。
    const decoder = new SseDecoder();
    const events = decoder.push(frame(1, value));
    assert.equal(events.length, 1, JSON.stringify(value));
    assert.equal(events[0]!.data, value, 'data 被改写：' + JSON.stringify(value));
    assert.equal(events[0]!.id, 1);
  }
  // 契约只要求「含 data: <内容>」；多行 data 的拼接语义未在契约中约定，
  // 因此只验证帧仍被正确解析为单个事件，不假设拼接规则。
  const multiline = new SseDecoder();
  const events = multiline.push('id: 1\ndata: line1\ndata: line2\n\n');
  assert.equal(events.length, 1, '多行 data 没有解析成单个事件');
  assert.equal(events[0]!.id, 1);
});

test('hidden/last-id-only-advances-on-delivery', () => {
  // lastId 必须只反映已投递的事件：被忽略的重放与失败的间隙都不推进。
  const decoder = new SseDecoder();
  assert.equal(decoder.lastId, 0, '初始 lastId 不是 0');
  decoder.push(frame(1, 'a'));
  assert.equal(decoder.lastId, 1);
  // 重放不推进。
  decoder.push(frame(1, 'replay'));
  assert.equal(decoder.lastId, 1, '重放推进了 lastId');
  // 间隙失败不推进。
  assert.throws(() => decoder.push(frame(9, 'gap')));
  assert.equal(decoder.lastId, 1, '间隙失败推进了 lastId');
  // 连续投递推进到投递的那一项。
  decoder.push(frame(2, 'b'));
  assert.equal(decoder.lastId, 2);
  // 一个块里多个帧：推进到最后投递的 id。
  const multi = new SseDecoder();
  multi.push(frame(1, 'a') + frame(2, 'b') + frame(3, 'c'));
  assert.equal(multi.lastId, 3);
});
