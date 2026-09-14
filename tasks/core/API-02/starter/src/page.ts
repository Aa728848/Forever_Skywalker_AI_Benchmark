export interface PageRequest {
  readonly cursor: string | null;
  readonly limit: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export class PageError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'PageError';
    this.field = field;
  }
}

export function encodeCursor(offset: number): string {
  return Buffer.from('offset:' + offset, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): number {
  // 缺陷：不校验前缀、不校验数值，非法游标得到 NaN 而不是 PageError。
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  return Number(text.split(':')[1]);
}

export function paginate<T>(items: readonly T[], request: PageRequest): Page<T> {
  if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100) {
    throw new PageError('limit', 'limit 必须是 1..100 的整数');
  }
  const offset = request.cursor === null ? 0 : decodeCursor(request.cursor);
  const page = items.slice(offset, offset + request.limit);
  const next = offset + page.length;
  return { items: page, nextCursor: next < items.length ? encodeCursor(next) : null };
}
