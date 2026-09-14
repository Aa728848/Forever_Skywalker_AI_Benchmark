export type OrderState = 'draft' | 'placed' | 'paid' | 'shipped' | 'cancelled';

export interface Snapshot {
  readonly version: 2;
  readonly state: OrderState;
}

export class InvalidSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSnapshotError';
  }
}

export class UnsupportedVersionError extends Error {
  readonly version: string;
  constructor(version: string) {
    super('不支持的快照版本：' + version);
    this.name = 'UnsupportedVersionError';
    this.version = version;
  }
}

export class UnknownStateError extends Error {
  readonly state: string;
  constructor(state: string) {
    super('未知的旧状态名：' + state);
    this.name = 'UnknownStateError';
    this.state = state;
  }
}

export const orderStates: readonly OrderState[] = ['draft', 'placed', 'paid', 'shipped', 'cancelled'];

export function migrate(raw: unknown): Snapshot {
  if (typeof raw !== 'object' || raw === null) throw new InvalidSnapshotError('快照必须是对象');
  // 缺陷：不检查 version，也不认 v1 的 status 字段，直接把 state 当作 v2。
  const state = (raw as { state?: unknown }).state;
  if (typeof state !== 'string') throw new InvalidSnapshotError('缺少 state');
  return { version: 2, state: state as OrderState };
}
