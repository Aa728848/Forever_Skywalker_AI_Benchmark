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

let cached: Settings | null = null;

export function resolveSettings(port: HostPort): Settings {
  // 缺陷：模块级缓存让第二次调用看不到新的宿主设置。
  if (cached !== null) return cached;
  // 缺陷：直接读宿主环境变量，绕过注入端口，且优先级高于端口。
  const mode = (process.env.APP_MODE ?? port.readSetting('mode')) === 'prod' ? 'prod' : 'dev';
  const endpoint = process.env.APP_ENDPOINT ?? port.readSetting('endpoint');
  if (endpoint === null || endpoint === undefined || endpoint === '') throw new SettingsError('endpoint', '缺少 endpoint');
  const raw = port.readSetting('retries');
  const retries = raw === null ? 3 : Number(raw);
  if (!Number.isInteger(retries) || retries < 0 || retries > 10) throw new SettingsError('retries', 'retries 必须是 0..10 的整数');
  cached = Object.freeze({ mode, endpoint, retries });
  return cached;
}
