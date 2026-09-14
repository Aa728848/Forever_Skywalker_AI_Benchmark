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

/** 替代实现：用显式阶段机（prepare/commit/rollback）表达同一条规则。 */
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

  #prepare(next: Plugin): boolean {
    try {
      next.setup();
      return true;
    } catch {
      this.#released.push(next.id);
      next.teardown();
      return false;
    }
  }

  switchTo(next: Plugin): Promise<void> {
    if (next.id === this.#active.id) return Promise.resolve();
    const previous = this.#active;
    if (!this.#prepare(next)) throw new SwitchError(previous.id, next.id, new Error('setup 失败'));
    this.#active = next;
    this.#released.push(previous.id);
    previous.teardown();
    return Promise.resolve();
  }
}
