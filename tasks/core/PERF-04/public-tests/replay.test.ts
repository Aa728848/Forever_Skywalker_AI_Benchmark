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

test('public/counts-sessions-and-messages', () => {
  const summary = replaySession(makeEvents(400, 7, 11));
  const expected = naiveSummary(makeEvents(400, 7, 11));
  assert.deepEqual(summary, expected);
  assert.equal(summary.sessions, 7);
  assert.ok(summary.messages > 0);
});

test('public/bytes-counts-utf8', () => {
  const events: SessionEvent[] = [
    { id: 'a', at: 1, kind: 'message', session: 's', payload: '中文' },
    { id: 'b', at: 2, kind: 'message', session: 's', payload: 'ab' },
    { id: 'c', at: 3, kind: 'open', session: 's' },
  ];
  assert.equal(replaySession(events).bytes, 6 + 2);
});

test('public/last-at-and-empty-input', () => {
  assert.deepEqual(replaySession([]), { sessions: 0, messages: 0, bytes: 0, lastAt: null, longestSession: null });
  const events: SessionEvent[] = [
    { id: 'a', at: 50, kind: 'open', session: 's' },
    { id: 'b', at: 10, kind: 'message', session: 's' },
    { id: 'c', at: 70, kind: 'close', session: 's' },
  ];
  assert.equal(replaySession(events).lastAt, 70);
});

test('public/longest-session-tie-break', () => {
  const events: SessionEvent[] = [
    { id: 'a', at: 1, kind: 'message', session: 'beta' },
    { id: 'b', at: 2, kind: 'message', session: 'alpha' },
    { id: 'c', at: 3, kind: 'message', session: 'gamma' },
    { id: 'd', at: 4, kind: 'open', session: 'beta' },
  ];
  assert.deepEqual(replaySession(events).longestSession, { id: 'alpha', messages: 1 });
});

test('public/matches-naive-reference', () => {
  for (const seed of [1, 2, 3, 5, 8]) {
    const events = makeEvents(120, 4, seed);
    assert.deepEqual(replaySession(events), naiveSummary(events));
  }
});

test('public/input-accesses-are-linear', () => {
  const counted = counting(makeEvents(2000, 2000, 17));
  const summary = replaySession(counted.events);
  const accesses = counted.accesses();
  assert.equal(summary.sessions, 2000);
  assert.ok(accesses <= 8 * 2000, '元素访问次数必须与输入规模同阶，实际 ' + accesses);
});
