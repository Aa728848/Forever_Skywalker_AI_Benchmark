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

export class TaskGroup {
  readonly #members = new Map<string, Member>();

  get active(): readonly string[] {
    return [...this.#members.keys()];
  }

  run<T>(id: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let resolveOuter: (value: T) => void = () => {};
    let rejectOuter: (error: unknown) => void = () => {};
    const promise = new Promise<T>((resolve, reject) => {
      resolveOuter = resolve;
      rejectOuter = reject;
    });
    const member: Member = { controller, reject: rejectOuter, done: Promise.resolve() };
    const started = (() => {
      try {
        return Promise.resolve(work(controller.signal));
      } catch (error) {
        return Promise.reject(error);
      }
    })();
    const finished = started.then(
      value => {
        if (this.#members.get(id) === member) this.#members.delete(id);
        resolveOuter(value);
      },
      error => {
        if (this.#members.get(id) === member) this.#members.delete(id);
        rejectOuter(error);
      },
    );
    member.done = finished.then(() => undefined, () => undefined);
    this.#members.set(id, member);
    return promise;
  }

  async cancelAll(): Promise<void> {
    // 缺陷：既不 abort signal、也不清理 active，还用普通 Error 拒绝并且不等待成员结算。
    for (const member of this.#members.values()) member.reject(new Error('已取消'));
  }
}
