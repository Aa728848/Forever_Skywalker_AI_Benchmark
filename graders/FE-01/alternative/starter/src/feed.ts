export interface FeedItem {
  readonly id: string;
  readonly text: string;
}

export interface FeedPage {
  readonly items: readonly FeedItem[];
  readonly cursor: string | null;
}

export interface FeedView {
  render(items: readonly FeedItem[]): void;
  setBusy(busy: boolean): void;
  setError(message: string | null): void;
}

/** 替代实现：状态集中在一个字段对象里，去重与视图通知走统一的 commit 路径。 */
interface FeedState {
  items: FeedItem[];
  cursor: string | null;
  pending: string | null;
  busy: boolean;
  error: string | null;
}

export class FeedController {
  readonly #load: (cursor: string | null) => Promise<FeedPage>;
  readonly #view: FeedView;
  readonly #state: FeedState = { items: [], cursor: null, pending: null, busy: false, error: null };

  constructor(load: (cursor: string | null) => Promise<FeedPage>, view: FeedView) {
    this.#load = load;
    this.#view = view;
  }

  get items(): readonly FeedItem[] {
    return this.#state.items.slice();
  }

  get busy(): boolean {
    return this.#state.busy;
  }

  get error(): string | null {
    return this.#state.error;
  }

  async loadMore(): Promise<void> {
    await this.#run(this.#state.cursor);
  }

  async retry(): Promise<void> {
    await this.#run(this.#state.pending ?? this.#state.cursor);
  }

  async #run(cursor: string | null): Promise<void> {
    const state = this.#state;
    if (state.busy) return;
    state.busy = true;
    this.#view.setBusy(true);
    let outcome: { ok: true; page: FeedPage } | { ok: false; message: string };
    try {
      outcome = { ok: true, page: await this.#load(cursor) };
    } catch (error) {
      outcome = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    state.busy = false;
    this.#view.setBusy(false);
    if (!outcome.ok) {
      state.error = outcome.message;
      state.pending = cursor;
      this.#view.setError(state.error);
      return;
    }
    const ids = new Set(state.items.map(item => item.id));
    state.items = state.items.concat(outcome.page.items.filter(item => !ids.has(item.id)));
    state.cursor = outcome.page.cursor;
    state.pending = null;
    state.error = null;
    this.#view.setError(null);
    this.#view.render(state.items.slice());
  }
}

