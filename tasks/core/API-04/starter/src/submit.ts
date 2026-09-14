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

  submit(key: string, payload: string): Promise<string> {
    if (key === '') return Promise.reject(new SubmitError(key, '提交键不得为空'));
    // 缺陷：不读幂等记录、不查已有 taskId，每次都新建并覆盖写。
    this.#sequence += 1;
    const taskId = 'task-' + this.#sequence;
    this.#store.write(entryKey(key), taskId + '|' + payload);
    this.#committed.push(taskId);
    return Promise.resolve(taskId);
  }
}
