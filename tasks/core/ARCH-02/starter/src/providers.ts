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

/** 缺陷：按 id 前缀猜“浏览器专属”，而不是读 provider.runtime 元数据。 */
const browserOnlyPrefix = 'browser-';

export function resolveProviders(catalog: readonly Provider[], runtime: 'browser' | 'node'): ResolvedProviders {
  assertCatalog(catalog);
  const usable: Provider[] = [];
  const skipped: string[] = [];
  for (const provider of catalog) {
    const isBrowserOnly = provider.id.startsWith(browserOnlyPrefix);
    if (runtime === 'browser' || !isBrowserOnly) usable.push(provider);
    else skipped.push(provider.id);
  }
  return { usable, skipped };
}
