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
    for (const name of order) {
      const layer = this.#layers[name];
      try {
        layer.apply(value);
      } catch (error) {
        // 缺陷：只回滚失败的那一层，之前已经应用成功的层被留在半成品状态。
        layer.revert(value);
        return Promise.reject(new CommitError(name, error));
      }
    }
    this.#applied.push(value);
    return Promise.resolve(value);
  }
}
