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
  return Object.prototype.toString.call(value) === '[object Object]';
}

export function validateOrderRequest(payload: unknown): OrderRequest {
  if (!isRecord(payload)) throw new RequestError([{ field: '', code: 'type' }]);
  const issues: ValidationIssue[] = [];

  const unknown = Object.keys(payload).filter(field => !knownFields.includes(field));
  for (const field of unknown) issues.push({ field, code: 'unknown-field' });

  const orderId = payload.orderId;
  if (orderId === undefined) issues.push({ field: 'orderId', code: 'missing' });
  else if (typeof orderId !== 'string' || orderId.trim() === '') issues.push({ field: 'orderId', code: 'type' });

  const quantity = payload.quantity;
  if (quantity === undefined) issues.push({ field: 'quantity', code: 'missing' });
  else if (typeof quantity !== 'number' || !Number.isFinite(quantity) || !Number.isInteger(quantity)) issues.push({ field: 'quantity', code: 'type' });
  else if (quantity < 1 || quantity > 1000) issues.push({ field: 'quantity', code: 'range' });

  const note = payload.note;
  if (note !== undefined) {
    if (typeof note !== 'string' || note.trim() === '' || note.length > 200) issues.push({ field: 'note', code: 'type' });
  }

  if (issues.length > 0) throw new RequestError(issues);
  const result: OrderRequest = note === undefined
    ? { orderId: orderId as string, quantity: quantity as number }
    : { orderId: orderId as string, quantity: quantity as number, note: note as string };
  return Object.freeze(result);
}
