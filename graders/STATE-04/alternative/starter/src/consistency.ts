export interface Layer {
  readonly name: string;
  apply(value: string): void;
  revert(value: string): void;
  has(value: string): boolean;
}

export interface Layers {
  readonly service: Layer;
  readonly cache: Layer;
  readonly ui: Layer;
}

export class CommitError extends Error {
  readonly layer: string;
  constructor(layer: string, cause: unknown) {
    super('提交在 ' + layer + ' 层失败（' + String(cause) + '）');
    this.name = 'CommitError';
    this.layer = layer;
  }
}

const order: readonly ('service' | 'cache' | 'ui')[] = ['service', 'cache', 'ui'];

/** 替代实现：先记录反向撤销函数，失败时统一执行。 */
export class Coordinator {
  readonly #layers: Layers;
  readonly #applied: string[] = [];

  constructor(layers: Layers) {
    this.#layers = layers;
  }

  get applied(): readonly string[] {
    return [...this.#applied];
  }

  commit(value: string): Promise<string> {
    if (this.#applied.includes(value)) return Promise.resolve(value);
    const undo: Array<() => void> = [];
    const failure = order
      .map(name => {
        const layer = this.#layers[name];
        try {
          layer.apply(value);
          undo.push(() => { layer.revert(value); });
          return null;
        } catch (error) {
          return new CommitError(name, error);
        }
      })
      .find(error => error !== null);
    if (failure !== undefined && failure !== null) {
      for (const revert of undo.reverse()) revert();
      return Promise.reject(failure);
    }
    this.#applied.push(value);
    return Promise.resolve(value);
  }
}
