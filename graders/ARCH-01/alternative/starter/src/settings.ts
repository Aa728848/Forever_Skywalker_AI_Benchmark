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
  let retries = 3;
  if (raw !== null) {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10) throw new SettingsError('retries', 'retries 必须是 0..10 的整数');
    retries = parsed;
  }
  return Object.freeze({ mode, endpoint, retries });
}
