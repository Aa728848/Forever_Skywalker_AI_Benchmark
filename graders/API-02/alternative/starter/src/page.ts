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

/** 替代实现：先按固定前缀切分再逐字符校验数字。 */
export function decodeCursor(cursor: string): number {
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const prefix = 'offset:';
  if (!text.startsWith(prefix)) throw new PageError('cursor', '游标前缀非法');
  const digits = text.slice(prefix.length);
  if (digits === '' || ![...digits].every(character => character >= '0' && character <= '9')) {
    throw new PageError('cursor', '游标偏移必须是十进制数字');
  }
  const offset = Number.parseInt(digits, 10);
  if (String(offset) !== digits) throw new PageError('cursor', '游标不是规范编码');
  return offset;
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
