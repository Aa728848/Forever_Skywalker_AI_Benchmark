export type Runtime = 'shared' | 'browser' | 'node';

export interface Provider {
  readonly id: string;
  readonly runtime: Runtime;
  readonly label: string;
}

export class DuplicateProviderError extends Error {
  readonly id: string;
  constructor(id: string) {
    super('重复的 provider id：' + id);
    this.name = 'DuplicateProviderError';
    this.id = id;
  }
}

export class InvalidProviderError extends Error {
  readonly id: string;
  constructor(id: string) {
    super('provider 元数据非法：' + id);
    this.name = 'InvalidProviderError';
    this.id = id;
  }
}

export interface ResolvedProviders {
  readonly usable: readonly Provider[];
  readonly skipped: readonly string[];
}

function assertCatalog(catalog: readonly Provider[]): void {
  const seen = new Set<string>();
  for (const provider of catalog) {
    if (typeof provider.id !== 'string' || provider.id === '') throw new InvalidProviderError(String(provider.id));
    if (provider.runtime !== 'shared' && provider.runtime !== 'browser' && provider.runtime !== 'node') {
      throw new InvalidProviderError(provider.id);
    }
    if (seen.has(provider.id)) throw new DuplicateProviderError(provider.id);
    seen.add(provider.id);
  }
}

/** 替代实现：单次遍历按目录顺序分流，保持 usable 与 skipped 的原始相对顺序。 */
export function resolveProviders(catalog: readonly Provider[], runtime: 'browser' | 'node'): ResolvedProviders {
  assertCatalog(catalog);
  // 分桶会丢失目录顺序（shared 与匹配项会被分开再拼接），
  // 因此这里直接按目录顺序分流。
  const usable: Provider[] = [];
  const skipped: string[] = [];
  for (const provider of catalog) {
    if (provider.runtime === 'shared' || provider.runtime === runtime) usable.push(provider);
    else skipped.push(provider.id);
  }
  return { usable, skipped };
}
