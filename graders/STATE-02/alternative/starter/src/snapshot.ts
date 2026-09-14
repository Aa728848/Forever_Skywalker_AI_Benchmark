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

/** 替代实现：按版本分派到独立函数，映射表用 Map。 */
const legacy = new Map<string, OrderState>([['new', 'draft'], ['active', 'placed'], ['done', 'shipped']]);

function fromV2(record: Record<string, unknown>): Snapshot {
  const state = record.state;
  if (typeof state !== 'string' || !orderStates.includes(state as OrderState)) {
    throw new InvalidSnapshotError('v2 快照的 state 非法');
  }
  return { version: 2, state: state as OrderState };
}

function fromV1(record: Record<string, unknown>): Snapshot {
  const status = record.status;
  if (typeof status !== 'string') throw new InvalidSnapshotError('v1 快照缺少 status');
  const mapped = legacy.get(status);
  if (mapped === undefined) throw new UnknownStateError(status);
  return { version: 2, state: mapped };
}

export function migrate(raw: unknown): Snapshot {
  if (typeof raw !== 'object' || raw === null) throw new InvalidSnapshotError('快照必须是对象');
  const record = raw as Record<string, unknown>;
  switch (record.version) {
    case 2:
      return fromV2(record);
    case 1:
      return fromV1(record);
    default:
      throw new UnsupportedVersionError(String(record.version));
  }
}
