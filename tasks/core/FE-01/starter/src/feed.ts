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

export class FeedController {
  readonly #load: (cursor: string | null) => Promise<FeedPage>;
  readonly #view: FeedView;
  #items: FeedItem[] = [];
  #cursor: string | null = null;
  #busy = false;
  #error: string | null = null;

  constructor(load: (cursor: string | null) => Promise<FeedPage>, view: FeedView) {
    this.#load = load;
    this.#view = view;
  }

  get items(): readonly FeedItem[] {
    return [...this.#items];
  }

  get busy(): boolean {
    return this.#busy;
  }

  get error(): string | null {
    return this.#error;
  }

  async loadMore(): Promise<void> {
    if (this.#busy) return;
    await this.#fetch(this.#cursor);
  }

  async retry(): Promise<void> {
    if (this.#busy) return;
    await this.#fetch(this.#cursor);
  }

  async #fetch(cursor: string | null): Promise<void> {
    this.#busy = true;
    this.#view.setBusy(true);
    try {
      const page = await this.#load(cursor);
      for (const item of page.items) this.#items.push(item);
      this.#cursor = page.cursor;
      this.#error = null;
      this.#busy = false;
      this.#view.setBusy(false);
      this.#view.setError(null);
      this.#view.render([...this.#items]);
    } catch (error) {
      this.#error = error instanceof Error ? error.message : String(error);
      this.#view.setError(this.#error);
    }
  }
}

