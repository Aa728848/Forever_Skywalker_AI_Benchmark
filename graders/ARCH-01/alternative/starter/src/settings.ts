export interface HostPort {
  readSetting(key: string): string | null;
}

export interface Settings {
  readonly mode: 'dev' | 'prod';
  readonly endpoint: string;
  readonly retries: number;
}

export class SettingsError extends Error {
  readonly key: string;
  constructor(key: string, message: string) {
    super(message);
    this.name = 'SettingsError';
    this.key = key;
  }
}

/** 替代实现：先把端口值收进局部表，再统一校验与冻结。 */
export function resolveSettings(port: HostPort): Settings {
  const values = new Map<string, string | null>();
  for (const key of ['mode', 'endpoint', 'retries']) values.set(key, port.readSetting(key));
  const mode = values.get('mode') === 'prod' ? 'prod' : 'dev';
  const endpoint = values.get('endpoint') ?? null;
  if (endpoint === null || endpoint.trim() === '') throw new SettingsError('endpoint', '缺少 endpoint');
  const raw = values.get('retries') ?? null;
  // 契约要求按字符串判定：只接受 /^[0-9]+$/，不能靠 Number() 的宽松转换。
  if (raw !== null && !/^[0-9]+$/.test(raw)) throw new SettingsError('retries', 'retries 必须是 0..10 的整数');
  const retries = raw === null ? 3 : Number(raw);
  if (retries > 10) throw new SettingsError('retries', 'retries 必须是 0..10 的整数');
  return Object.freeze({ mode, endpoint, retries });
}
