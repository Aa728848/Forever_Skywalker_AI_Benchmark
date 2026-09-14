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

/** 替代实现：一次分区（partition）后按需拼接。 */
export function resolveProviders(catalog: readonly Provider[], runtime: 'browser' | 'node'): ResolvedProviders {
  assertCatalog(catalog);
  const groups = new Map<Runtime | 'other', Provider[]>([
    ['shared', []],
    ['browser', []],
    ['node', []],
    ['other', []],
  ]);
  for (const provider of catalog) {
    const bucket = provider.runtime === runtime ? runtime : provider.runtime;
    (groups.get(bucket) ?? groups.get('other')).push(provider);
  }
  const usable = [...(groups.get('shared') ?? []), ...(groups.get(runtime) ?? [])];
  const usableIds = new Set(usable.map(provider => provider.id));
  const skipped = catalog.filter(provider => !usableIds.has(provider.id)).map(provider => provider.id);
  return { usable, skipped };
}
