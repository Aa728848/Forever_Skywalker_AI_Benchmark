export type Release = () => void;

interface Waiter {
  readonly resolve: (release: Release) => void;
}

export class LockManager {
  readonly #held = new Set<string>();
  readonly #waiting = new Map<string, Waiter[]>();

  get queueLength(): number {
    let total = 0;
    for (const list of this.#waiting.values()) total += list.length;
    return total;
  }

  acquire(resource: string): Promise<Release> {
    if (!this.#held.has(resource)) {
      // 缺陷：只要资源空闲就直接授予，排队中的请求被后来者插队（饥饿）。
      this.#held.add(resource);
      return Promise.resolve(this.#grant(resource));
    }
    return new Promise<Release>(resolve => {
      const list = this.#waiting.get(resource) ?? [];
      list.push({ resolve });
      this.#waiting.set(resource, list);
    });
  }

  #grant(resource: string): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#held.delete(resource);
      const list = this.#waiting.get(resource) ?? [];
      // 缺陷：唤醒最后入队者（LIFO），先来的请求被无限推迟。
      const next = list.pop();
      if (next !== undefined) {
        this.#held.add(resource);
        next.resolve(this.#grant(resource));
      }
    };
  }
}
