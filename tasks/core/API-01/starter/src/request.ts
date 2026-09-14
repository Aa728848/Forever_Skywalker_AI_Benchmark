export interface OrderRequest {
  readonly orderId: string;
  readonly quantity: number;
  readonly note?: string;
}

export interface ValidationIssue {
  readonly field: string;
  readonly code: 'missing' | 'type' | 'range' | 'unknown-field';
}

export class RequestError extends Error {
  readonly status: number;
  readonly issues: ValidationIssue[];
  constructor(issues: ValidationIssue[]) {
    super('请求校验失败：' + issues.map(issue => issue.field + ':' + issue.code).join('、'));
    this.name = 'RequestError';
    this.status = 400;
    this.issues = issues;
  }
}

const knownFields = ['orderId', 'quantity', 'note'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateOrderRequest(payload: unknown): OrderRequest {
  if (!isRecord(payload)) throw new RequestError([{ field: '', code: 'type' }]);
  const issues: ValidationIssue[] = [];

  const orderId = payload.orderId;
  if (orderId === undefined) issues.push({ field: 'orderId', code: 'missing' });
  else if (typeof orderId !== 'string' || orderId.trim() === '') issues.push({ field: 'orderId', code: 'type' });

  const quantity = payload.quantity;
  if (quantity === undefined) issues.push({ field: 'quantity', code: 'missing' });
  else {
    const parsed = typeof quantity === 'string' ? Number(quantity) : quantity;
    if (typeof parsed !== 'number' || !Number.isFinite(parsed)) issues.push({ field: 'quantity', code: 'type' });
    else if (parsed < 0 || parsed > 1000) issues.push({ field: 'quantity', code: 'range' });
  }

  if (issues.length > 0) throw new RequestError(issues);
  // 缺陷：未知字段被静默丢弃，而不是按契约报 unknown-field。
  const accepted: Record<string, unknown> = {};
  for (const field of Object.keys(payload)) if (knownFields.includes(field)) accepted[field] = payload[field];
  const note = accepted.note;
  return note === undefined
    ? { orderId: orderId as string, quantity: quantity as number }
    : { orderId: orderId as string, quantity: quantity as number, note: note as string };
}
