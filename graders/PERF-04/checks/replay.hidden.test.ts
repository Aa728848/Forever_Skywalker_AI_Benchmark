import test from 'node:test';
import assert from 'node:assert/strict';
import { replaySession, type SessionEvent, type SessionSummary } from '../starter/src/replay.ts';

/** 固定种子的确定性输入；同一 (count, sessionCount, seed) 永远生成同一批事件。 */
function makeEvents(count: number, sessionCount: number, seed: number): SessionEvent[] {
  const events: SessionEvent[] = [];
  let state = seed;
  const next = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state;
  };
  for (let index = 0; index < count; index += 1) {
    const roll = next() % 10;
    const kind: SessionEvent['kind'] = roll === 0 ? 'open' : roll === 1 ? 'close' : 'message';
    const common = { id: 'e' + index, at: 1000 + (next() % 5000), kind, session: 's' + (index % sessionCount) };
    events.push(next() % 3 === 0 ? common : { ...common, payload: '数据' + (next() % 100) });
  }
  return events;
}

/** 朴素但正确的参考实现，只用于小规模差分对照。 */
function naiveSummary(events: readonly SessionEvent[]): SessionSummary {
  const sessions = [...new Set(events.map(event => event.session ?? ''))];
  let longest: { id: string; messages: number } | null = null;
  for (const session of sessions) {
    const count = events.filter(event => (event.session ?? '') === session && event.kind === 'message').length;
    if (count === 0) continue;
    if (longest === null || count > longest.messages || (count === longest.messages && session < longest.id)) longest = { id: session, messages: count };
  }
  return {
    sessions: sessions.length,
    messages: events.filter(event => event.kind === 'message').length,
    bytes: events.reduce((sum, event) => sum + (event.payload === undefined ? 0 : Buffer.byteLength(event.payload, 'utf8')), 0),
    lastAt: events.length === 0 ? null : Math.max(...events.map(event => event.at)),
    longestSession: longest,
  };
}

/** 用 Proxy 统计实现对输入数组的元素访问次数，用于复杂度断言（不依赖计时）。 */
function counting(events: SessionEvent[]): { readonly events: readonly SessionEvent[]; accesses: () => number } {
  let count = 0;
  const proxy = new Proxy(events, {
    get(target, property, receiver) {
      count += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  return { events: proxy as readonly SessionEvent[], accesses: () => count };
}

test('hidden/scaling-ratio-is-subquadratic', () => {
  const small = counting(makeEvents(500, 500, 23));
  replaySession(small.events);
  const large = counting(makeEvents(2000, 2000, 23));
  replaySession(large.events);
  const ratio = large.accesses() / small.accesses();
  assert.ok(large.accesses() <= 8 * 2000, '访问次数必须线性，实际 ' + large.accesses());
  assert.ok(ratio <= 8, '4 倍规模下访问次数比值必须亚二次，实际 ' + ratio.toFixed(2));
});

test('hidden/unique-sessions-per-event', () => {
  const events: SessionEvent[] = [];
  for (let index = 0; index < 2000; index += 1) {
    events.push({ id: 'e' + index, at: index, kind: index % 2 === 0 ? 'message' : 'close', session: 'sess-' + index, payload: 'x' });
  }
  const summary = replaySession(events);
  assert.equal(summary.sessions, 2000);
  assert.equal(summary.messages, 1000);
  assert.equal(summary.bytes, 2000);
  assert.equal(summary.lastAt, 1999);
  assert.deepEqual(summary.longestSession, { id: 'sess-0', messages: 1 });
});

test('hidden/default-session-is-empty-string', () => {
  const events: SessionEvent[] = [
    { id: 'a', at: 1, kind: 'message' },
    { id: 'b', at: 2, kind: 'message', session: '' },
    { id: 'c', at: 3, kind: 'message', session: 'other' },
  ];
  const summary = replaySession(events);
  assert.equal(summary.sessions, 2);
  assert.deepEqual(summary.longestSession, { id: '', messages: 2 });
});

test('hidden/does-not-mutate-input', () => {
  const events = makeEvents(50, 3, 31);
  const snapshot = JSON.stringify(events);
  const first = replaySession(events);
  const second = replaySession(events);
  assert.equal(JSON.stringify(events), snapshot);
  assert.deepEqual(first, second);
});

test('hidden/timing-samples-are-bounded', () => {
  const events = makeEvents(5000, 40, 41);
  for (let index = 0; index < 2; index += 1) replaySession(events);
  const samples: { round: number; durationMs: number; rssBytes: number; heapUsedBytes: number }[] = [];
  for (let index = 0; index < 7; index += 1) {
    const started = process.hrtime.bigint();
    replaySession(events);
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    const memory = process.memoryUsage();
    samples.push({ round: index + 1, durationMs, rssBytes: memory.rss, heapUsedBytes: memory.heapUsed });
  }
  const times = samples.map(sample => sample.durationMs).sort((left, right) => left - right);
  const median = times[Math.floor(times.length / 2)] as number;
  console.log('性能原始样本：' + JSON.stringify({ n: 5000, warmups: 2, samples, medianMs: median, measurementTrust: 'in-process-diagnostic' }));
  assert.ok(median < 10000, 'n=5000 的中位耗时必须远低于预算，实际 ' + median.toFixed(2) + 'ms');
});
