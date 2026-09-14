export interface LegacyResult { readonly ok: boolean; readonly ms: number; readonly payload?: string }
export interface LegacyAdapter { fetch(id: string): LegacyResult }
export interface V2Result { readonly status: 'ok' | 'missing'; readonly durationSeconds: number; readonly body: string | null }
export interface AdapterV2 { load(id: string): Promise<V2Result> }
export interface ReadResult { readonly ok: boolean; readonly durationMs: number; readonly body: string | null }

export class AdapterError extends Error {
  readonly id: string;
  constructor(id: string, cause: unknown) {
    super('适配器调用失败：' + id + '（' + String(cause) + '）');
    this.name = 'AdapterError';
    this.id = id;
  }
}

function isV2(adapter: LegacyAdapter | AdapterV2): adapter is AdapterV2 {
  return typeof (adapter as AdapterV2).load === 'function';
}

function fromV2(result: V2Result): ReadResult {
  const ok = result.status === 'ok';
  return { ok, durationMs: result.durationSeconds * 1000, body: ok ? result.body : null };
}

function fromLegacy(result: LegacyResult): ReadResult {
  return { ok: result.ok, durationMs: result.ms, body: result.payload ?? null };
}

export class Repository {
  readonly #adapter: LegacyAdapter | AdapterV2;

  constructor(adapter: LegacyAdapter | AdapterV2) {
    this.#adapter = adapter;
  }

  async read(id: string): Promise<ReadResult> {
    const v2 = isV2(this.#adapter);
    let promise: Promise<ReadResult>;
    try {
      promise = v2 ? this.#adapter.load(id).then(fromV2) : Promise.resolve(fromLegacy(this.#adapter.fetch(id)));
    } catch (error) {
      throw new AdapterError(id, error);
    }
    return promise.catch(error => {
      throw error instanceof AdapterError ? error : new AdapterError(id, error);
    });
  }
}
