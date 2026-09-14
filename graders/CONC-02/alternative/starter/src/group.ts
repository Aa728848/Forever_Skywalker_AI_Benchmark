export class GroupCancelledError extends Error {
  readonly pending: readonly string[];
  constructor(pending: readonly string[]) {
    super('任务组已取消，尚有未完成的成员：' + pending.join('、'));
    this.name = 'GroupCancelledError';
    this.pending = pending;
  }
}

interface Member {
  readonly controller: AbortController;
  readonly reject: (error: unknown) => void;
  done: Promise<void>;
}

/** 替代实现：成员放数组，取消时用 allSettled 等待，active 由数组过滤得出。 */
export class TaskGroup {
  readonly #members: Array<Member & { id: string }> = [];

  get active(): readonly string[] {
    return this.#members.map(member => member.id);
  }

  run<T>(id: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let resolveOuter: (value: T) => void = () => {};
    let rejectOuter: (error: unknown) => void = () => {};
    const promise = new Promise<T>((resolve, reject) => {
      resolveOuter = resolve;
      rejectOuter = reject;
    });
    const entry = { id, controller, reject: rejectOuter, done: Promise.resolve() };
    service(this.#members, entry);
    work(controller.signal).then(
      value => { remove(this.#members, entry); resolveOuter(value); },
      error => { remove(this.#members, entry); rejectOuter(error); },
    );
    return promise;
  }

  async cancelAll(): Promise<void> {
    const entries = [...this.#members];
    if (entries.length === 0) return;
    const pending = entries.map(entry => entry.id);
    const error = new GroupCancelledError(pending);
    for (const entry of entries) {
      entry.controller.abort();
      entry.reject(error);
      remove(this.#members, entry);
    }
    await Promise.allSettled(entries.map(entry => entry.done));
  }
}

function remove(list: Array<Member & { id: string }>, entry: Member & { id: string }): void {
  const index = list.indexOf(entry);
  if (index >= 0) list.splice(index, 1);
}

function service(list: Array<Member & { id: string }>, entry: Member & { id: string }): void {
  list.push(entry);
}
