import test from 'node:test';
import assert from 'node:assert/strict';
import { PageError, decodeCursor, encodeCursor, paginate } from '../starter/src/page.ts';

function failureOf(run: () => unknown): string {
  try { run(); return 'ok'; } catch (error) {
    return error instanceof PageError ? 'page:' + error.field : 'other:' + String(error);
  }
}

const items = Array.from({ length: 5 }, (_unused, index) => 'item-' + index);
const encode = (text: string) => Buffer.from(text, 'utf8').toString('base64url');

test('hidden/first-page-without-cursor', () => {
  const page = paginate(items, { cursor: null, limit: 2 });
  assert.deepEqual(page.items, ['item-0', 'item-1']);
  assert.equal(page.nextCursor, encodeCursor(2));
});

test('hidden/last-page-has-no-cursor', () => {
  const page = paginate(items, { cursor: encodeCursor(4), limit: 2 });
  assert.deepEqual(page.items, ['item-4']);
  assert.equal(page.nextCursor, null);
  const exact = paginate(items, { cursor: encodeCursor(3), limit: 2 });
  assert.deepEqual(exact.items, ['item-3', 'item-4']);
  assert.equal(exact.nextCursor, null, '取完最后一页时不得再给出游标');
});

test('hidden/rejects-invalid-cursor-text', () => {
  assert.equal(failureOf(() => decodeCursor(encode('offset:abc'))), 'page:cursor');
  assert.equal(failureOf(() => decodeCursor(encode('not-a-cursor'))), 'page:cursor');
  assert.equal(failureOf(() => decodeCursor('!!!not-base64!!!')), 'page:cursor');
  assert.equal(failureOf(() => paginate(items, { cursor: encode('offset:-1'), limit: 2 })), 'page:cursor');
});

test('hidden/rejects-noncanonical-cursor', () => {
  assert.equal(failureOf(() => decodeCursor(encode('offset:007'))), 'page:cursor');
  assert.equal(decodeCursor(encodeCursor(7)), 7);
  assert.equal(failureOf(() => encodeCursor(-1)), 'page:cursor');
});

test('hidden/rejects-out-of-range-limit', () => {
  assert.equal(failureOf(() => paginate(items, { cursor: null, limit: 0 })), 'page:limit');
  assert.equal(failureOf(() => paginate(items, { cursor: null, limit: 101 })), 'page:limit');
  assert.equal(failureOf(() => paginate(items, { cursor: null, limit: 1.5 })), 'page:limit');
  assert.deepEqual(paginate(items, { cursor: encodeCursor(99), limit: 3 }).items, []);
});
