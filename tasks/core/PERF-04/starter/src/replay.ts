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

/** 长会话回放：按会话逐个重新扫描输入统计消息数。 */
export function replaySession(events: readonly SessionEvent[]): SessionSummary {
  const sessions: string[] = [];
  for (const event of events) {
    const session = sessionOf(event);
    if (sessions.indexOf(session) < 0) sessions.push(session);
  }
  let messages = 0;
  for (const event of events) {
    if (event.kind === 'message') messages += 1;
  }
  let bytes = 0;
  for (const event of events) {
    bytes += payloadBytes(event);
  }
  let lastAt: number | null = null;
  for (const event of events) {
    if (lastAt === null || event.at > lastAt) lastAt = event.at;
  }
  let longestSession: { id: string; messages: number } | null = null;
  for (const session of sessions) {
    const count = events.filter(item => sessionOf(item) === session && item.kind === 'message').length;
    if (count === 0) continue;
    if (longestSession === null || count > longestSession.messages || (count === longestSession.messages && session < longestSession.id)) {
      longestSession = { id: session, messages: count };
    }
  }
  return { sessions: sessions.length, messages, bytes, lastAt, longestSession };
}

