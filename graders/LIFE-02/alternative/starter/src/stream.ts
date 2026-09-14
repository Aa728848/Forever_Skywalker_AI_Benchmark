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

/** 替代实现：用 frozen 布尔 + 优先级数字表示终态。 */
export class StreamCollector {
  readonly #timeoutMs: number;
  #total = 0;
  #count = 0;
  #frozen = false;
  #ended = false;
  #error: string | null = null;

  constructor(options: CollectorOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? 5000;
  }

  #accept(): boolean {
    return !this.#frozen;
  }

  push(event: StreamEvent): void {
    if (!this.#accept()) return;
    switch (event.kind) {
      case 'data':
        this.#total += event.value;
        this.#count += 1;
        return;
      case 'end':
        this.#ended = true;
        this.#frozen = true;
        return;
      default:
        this.#error = event.message;
        this.#frozen = true;
    }
  }

  timeout(): void {
    if (!this.#accept()) return;
    this.#error = '超时';
    this.#frozen = true;
  }

  get summary(): StreamSummary {
    return { total: this.#total, count: this.#count, ended: this.#ended, error: this.#error };
  }

  get timeoutMs(): number {
    return this.#timeoutMs;
  }
}
