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
    // 必须按固定顺序逐层应用并**遇错即停**：map 不会短路，
    // 会在首层失败后继续应用后续层，把未应用的层也纳入回滚集合。
    for (const name of order) {
      const layer = this.#layers[name];
      try {
        layer.apply(value);
        undo.push(() => { layer.revert(value); });
      } catch (error) {
        for (const revert of undo.reverse()) revert();
        return Promise.reject(new CommitError(name, error));
      }
    }
    this.#applied.push(value);
    return Promise.resolve(value);
  }
}
