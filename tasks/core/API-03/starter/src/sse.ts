export interface SseEvent {
  readonly id: number;
  readonly data: string;
}

export class SequenceGapError extends Error {
  readonly expected: number;
  readonly received: number;
  constructor(expected: number, received: number) {
    super('序列不连续：期望 ' + expected + '，收到 ' + received);
    this.name = 'SequenceGapError';
    this.expected = expected;
    this.received = received;
  }
}

export class MalformedFrameError extends Error {
  readonly frame: string;
  constructor(frame: string) {
    super('帧格式非法：' + frame);
    this.name = 'MalformedFrameError';
    this.frame = frame;
  }
}

function parseFrame(frame: string): SseEvent {
  const idMatch = /^id:\s*(\d+)$/m.exec(frame);
  const dataMatch = /^data:\s*(.*)$/m.exec(frame);
  if (idMatch === null || dataMatch === null) throw new MalformedFrameError(frame);
  return { id: Number(idMatch[1]), data: dataMatch[1] as string };
}

export class SseDecoder {
  #buffer = '';
  #lastId = 0;

  push(chunk: string): readonly SseEvent[] {
    this.#buffer += chunk;
    const events: SseEvent[] = [];
    let separator = this.#buffer.indexOf('\n\n');
    while (separator >= 0) {
      const frame = this.#buffer.slice(0, separator);
      this.#buffer = this.#buffer.slice(separator + 2);
      const event = parseFrame(frame);
      // 缺陷：只更新 lastId，不校验连续性也不忽略重放。
      this.#lastId = event.id;
      events.push(event);
      separator = this.#buffer.indexOf('\n\n');
    }
    return events;
  }

  end(): readonly SseEvent[] {
    if (this.#buffer.trim() === '') {
      this.#buffer = '';
      return [];
    }
    const frame = this.#buffer;
    this.#buffer = '';
    const event = parseFrame(frame);
    this.#lastId = event.id;
    return [event];
  }

  get lastId(): number {
    return this.#lastId;
  }
}
