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

/** 替代实现：先切分全部完整帧，再逐帧走“拒旧 / 查新 / 收下”三步。 */
export class SseDecoder {
  #buffer = '';
  #lastId = 0;

  #frames(chunk: string, flush: boolean): string[] {
    this.#buffer += chunk;
    const parts = this.#buffer.split('\n\n');
    this.#buffer = flush ? '' : (parts.pop() ?? '');
    return parts.filter(part => part.trim() !== '');
  }

  #collect(rawFrames: readonly string[]): SseEvent[] {
    const accepted: SseEvent[] = [];
    for (const frame of rawFrames) {
      const event = parseFrame(frame);
      if (event.id <= this.#lastId) continue;
      if (event.id !== this.#lastId + 1) throw new SequenceGapError(this.#lastId + 1, event.id);
      this.#lastId = event.id;
      accepted.push(event);
    }
    return accepted;
  }

  push(chunk: string): readonly SseEvent[] {
    return this.#collect(this.#frames(chunk, false));
  }

  end(): readonly SseEvent[] {
    const rest = this.#buffer;
    this.#buffer = '';
    return rest.trim() === '' ? [] : this.#collect([rest]);
  }

  get lastId(): number {
    return this.#lastId;
  }
}
