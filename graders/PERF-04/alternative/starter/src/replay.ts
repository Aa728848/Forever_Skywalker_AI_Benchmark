export interface SessionEvent {
  readonly id: string;
  readonly at: number;
  readonly kind: 'open' | 'message' | 'close';
  readonly session?: string;
  readonly payload?: string;
}

export interface SessionSummary {
  readonly sessions: number;
  readonly messages: number;
  readonly bytes: number;
  readonly lastAt: number | null;
  readonly longestSession: { readonly id: string; readonly messages: number } | null;
}

function sessionOf(event: SessionEvent): string {
  return event.session ?? '';
}

function payloadBytes(event: SessionEvent): number {
  return event.payload === undefined ? 0 : Buffer.byteLength(event.payload, 'utf8');
}

/** 替代实现：滑动窗口式累计（reduce + 局部累加器），会话统计在收尾阶段一次遍历 Map。 */
interface Accumulator {
  readonly sessions: Map<string, number>;
  messages: number;
  bytes: number;
  lastAt: number | null;
}

export function replaySession(events: readonly SessionEvent[]): SessionSummary {
  const accumulator: Accumulator = { sessions: new Map<string, number>(), messages: 0, bytes: 0, lastAt: null };
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index] as SessionEvent;
    accumulator.sessions.set(sessionOf(event), accumulator.sessions.get(sessionOf(event)) ?? 0);
    accumulator.messages += event.kind === 'message' ? 1 : 0;
    accumulator.bytes += payloadBytes(event);
    accumulator.lastAt = accumulator.lastAt === null ? event.at : Math.max(accumulator.lastAt, event.at);
    if (event.kind === 'message') accumulator.sessions.set(sessionOf(event), (accumulator.sessions.get(sessionOf(event)) ?? 0) + 1);
  }
  const ranked = [...accumulator.sessions.entries()]
    .filter(entry => entry[1] > 0)
    .sort((left, right) => (right[1] - left[1]) || (left[0] < right[0] ? -1 : 1));
  return {
    sessions: accumulator.sessions.size,
    messages: accumulator.messages,
    bytes: accumulator.bytes,
    lastAt: accumulator.lastAt,
    longestSession: ranked.length === 0 ? null : { id: ranked[0]![0], messages: ranked[0]![1] },
  };
}

