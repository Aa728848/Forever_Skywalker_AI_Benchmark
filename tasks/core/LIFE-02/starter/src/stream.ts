export type StreamEvent =
  | { readonly kind: 'data'; readonly value: number }
  | { readonly kind: 'end' }
  | { readonly kind: 'error'; readonly message: string };

export interface StreamSummary {
  readonly total: number;
  readonly count: number;
  readonly ended: boolean;
  readonly error: string | null;
}

export interface CollectorOptions {
  readonly timeoutMs?: number;
}

export class StreamCollector {
  readonly #timeoutMs: number;
  #total = 0;
  #count = 0;
  #ended = false;
  #error: string | null = null;

  constructor(options: CollectorOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? 5000;
  }

  push(event: StreamEvent): void {
    // 缺陷：没有终态概念——end/error/timeout 之后到达的事件照样生效。
    if (event.kind === 'data') {
      this.#total += event.value;
      this.#count += 1;
      return;
    }
    if (event.kind === 'end') {
      this.#ended = true;
      return;
    }
    this.#error = event.message;
  }

  timeout(): void {
    // 缺陷：超时只记录消息，不冻结流，也不幂等。
    this.#error = '超时';
  }

  get summary(): StreamSummary {
    return { total: this.#total, count: this.#count, ended: this.#ended, error: this.#error };
  }

  get timeoutMs(): number {
    return this.#timeoutMs;
  }
}
