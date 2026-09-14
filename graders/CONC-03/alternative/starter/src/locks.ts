export type Release = () => void;

interface Waiter {
  readonly resolve: (release: Release) => void;
}

/** 替代实现：每个资源一个显式 FIFO 数组，队首在释放时同步补位。 */
export class LockManager {
  readonly #held = new Set<string>();
  readonly #queues = new Map<string, Array<(release: Release) => void>>();

  get queueLength(): number {
    let total = 0;
    for (const queue of this.#queues.values()) total += queue.length;
    return total;
  }

  #hand(resource: string): void {
    const queue = this.#queues.get(resource);
    if (queue === undefined || queue.length === 0) {
      this.#queues.delete(resource);
      return;
    }
    const nextResolve = queue.shift() as (release: Release) => void;
    if (queue.length === 0) this.#queues.delete(resource);
    this.#held.add(resource);
    nextResolve(this.#createRelease(resource));
  }

  #createRelease(resource: string): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#held.delete(resource);
      this.#hand(resource);
    };
  }

  acquire(resource: string): Promise<Release> {
    const queue = this.#queues.get(resource);
    if (queue === undefined && !this.#held.has(resource)) {
      this.#held.add(resource);
      return Promise.resolve(this.#createRelease(resource));
    }
    return new Promise<Release>(resolve => {
      this.#queues.set(resource, [...(this.#queues.get(resource) ?? []), resolve]);
    });
  }
}
