import { MalformedFrameError, SequenceGapError, type SseEvent } from './sse.ts';
export class BackpressureError extends Error { constructor() { super('SSE 缓冲预算耗尽'); } }
export interface StreamOptions { readonly capacity: number; readonly maxBufferedBytes: number; readonly fromId: number }
export class ByteSseStream {
  #decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  #encoder = new TextEncoder();
  #buffer = '';
  #bytes = 0;
  #queue: SseEvent[] = [];
  #accepted: number;
  #delivered: number;
  #options: StreamOptions;
  #failure: unknown;
  #closed = false;
  constructor(options: StreamOptions) {
    if (!Number.isSafeInteger(options.capacity) || options.capacity < 1 || !Number.isSafeInteger(options.maxBufferedBytes) || options.maxBufferedBytes < 1 || !Number.isSafeInteger(options.fromId) || options.fromId < 0) throw new RangeError('流配置非法');
    this.#options = options; this.#accepted = this.#options.fromId; this.#delivered = options.fromId;
  }
  get queued(): number { return this.#queue.length; }
  get lastId(): number { return this.#delivered; }
  #assertOpen(): void { if (this.#failure !== undefined) throw this.#failure; if (this.#closed) throw new Error('SSE 已结束'); }
  #accept(frame: string): void {
    const id = /^id:\s*(\d+)$/m.exec(frame); const data = /^data: ?(.*)$/m.exec(frame);
    if (id === null || data === null || !Number.isSafeInteger(Number(id[1]))) throw new MalformedFrameError(frame);
    const event = { id: Number(id[1]), data: data[1]! };
    if (event.id <= this.#accepted) return;
    if (event.id !== this.#accepted + 1) throw new SequenceGapError(this.#accepted + 1, event.id);
    // 缺陷：未限制消费者积压队列。
    this.#queue.push(event); this.#accepted = event.id;
  }
  push(chunk: Uint8Array): void {
    this.#assertOpen();
    try {
      // 缺陷：未限制未闭合帧字节数。
      this.#bytes += chunk.byteLength;
      this.#buffer += new TextDecoder().decode(chunk);
      let boundary = this.#buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = this.#buffer.slice(0, boundary); this.#buffer = this.#buffer.slice(boundary + 2);
        this.#bytes -= this.#encoder.encode(frame + '\n\n').byteLength;
        this.#accept(frame); boundary = this.#buffer.indexOf('\n\n');
      }
    } catch (error) { this.#failure = error; throw error; }
  }
  end(): void {
    this.#assertOpen();
    try { this.#buffer += this.#decoder.decode(); if (this.#buffer.trim() !== '') this.#accept(this.#buffer); this.#buffer = ''; this.#bytes = 0; this.#closed = true; }
    catch (error) { this.#failure = error; throw error; }
  }
  drain(max: number): readonly SseEvent[] {
    if (this.#failure !== undefined) throw this.#failure;
    if (!Number.isSafeInteger(max) || max < 1) throw new RangeError('drain 数量非法');
    const result = this.#queue.splice(0, max); if (result.length > 0) this.#delivered = result[result.length - 1]!.id; return result;
  }
}
