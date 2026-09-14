export interface TaskStore {
  read(key: string): string | null;
  write(key: string, value: string): void;
}

export class SubmitError extends Error {
  readonly key: string;
  constructor(key: string, message: string) {
    super(message + '（key=' + key + '）');
    this.name = 'SubmitError';
    this.key = key;
  }
}

function entryKey(key: string): string {
  return 'task:' + key;
}

/** 旧接口保留既有的键去重语义；持久队列的新协议位于 queue.ts。 */
export class TaskSubmitter {
  readonly #store: TaskStore;
  readonly #committed: string[] = [];
  #sequence = 0;

  constructor(store: TaskStore) {
    this.#store = store;
  }

  get committed(): readonly string[] {
    return [...this.#committed];
  }

  #ensure(key: string): string | null {
    const existing = this.#store.read(entryKey(key));
    if (existing === null) return null;
    return existing.split('|')[0] as string;
  }

  submit(key: string, payload: string): Promise<string> {
    if (key === '') return Promise.reject(new SubmitError(key, '提交键不得为空'));
    const found = this.#ensure(key);
    if (found !== null) {
      if (!this.#committed.includes(found)) this.#committed.push(found);
      return Promise.resolve(found);
    }
    const candidate = 'task-' + Array.from({ length: key.length }, (_, index) => key.charCodeAt(index).toString(16).padStart(4, '0')).join('');
    try {
      this.#store.write(entryKey(key), candidate + '|' + payload);
    } catch (error) {
      return Promise.reject(new SubmitError(key, '写入失败：' + String(error)));
    }
    this.#sequence += 1;
    this.#committed.push(candidate);
    return Promise.resolve(candidate);
  }
}
