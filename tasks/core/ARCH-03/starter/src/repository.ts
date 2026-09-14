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

export class Repository {
  readonly #adapter: LegacyAdapter | AdapterV2;

  constructor(adapter: LegacyAdapter | AdapterV2) {
    this.#adapter = adapter;
  }

  async read(id: string): Promise<ReadResult> {
    if (isV2(this.#adapter)) {
      // 缺陷：v2 适配器直接透传字段——缺失被当成成功、秒被当成毫秒、错误也不包装。
      const result = await this.#adapter.load(id);
      return { ok: true, durationMs: result.durationSeconds, body: result.body };
    }
    const legacy = this.#adapter.fetch(id);
    return { ok: legacy.ok, durationMs: legacy.ms, body: legacy.payload ?? null };
  }
}
