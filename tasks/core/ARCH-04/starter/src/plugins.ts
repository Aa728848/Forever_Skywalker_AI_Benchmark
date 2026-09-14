export interface Plugin {
  readonly id: string;
  setup(): void;
  teardown(): void;
}

export class SwitchError extends Error {
  readonly from: string;
  readonly to: string;
  constructor(from: string, to: string, cause: unknown) {
    super('插件切换失败：' + from + ' → ' + to + '（' + String(cause) + '）');
    this.name = 'SwitchError';
    this.from = from;
    this.to = to;
  }
}

export class PluginHost {
  #active: Plugin;
  readonly #released: string[] = [];

  constructor(initial: Plugin) {
    initial.setup();
    this.#active = initial;
  }

  get active(): string {
    return this.#active.id;
  }

  get released(): readonly string[] {
    return [...this.#released];
  }

  switchTo(next: Plugin): Promise<void> {
    if (next.id === this.#active.id) return Promise.resolve();
    // 缺陷：先释放旧插件再启动新插件；新插件失败时旧插件已经没了，
    // 而且新插件已经占用的资源也没有被释放。
    const previous = this.#active;
    this.#released.push(previous.id);
    previous.teardown();
    next.setup();
    this.#active = next;
    return Promise.resolve();
  }
}
