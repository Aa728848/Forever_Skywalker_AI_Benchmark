import test from 'node:test';
import assert from 'node:assert/strict';
import { IncompleteSequenceError, InvalidUtf8Error, StreamDecoder } from '../starter/src/decoder.ts';

const encode = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf8'));

function failureOf(run: () => unknown): string {
  try { run(); return 'ok'; } catch (error) {
    if (error instanceof InvalidUtf8Error) return 'invalid:' + error.offset;
    if (error instanceof IncompleteSequenceError) return 'incomplete';
    return 'other:' + String(error);
  }
}

test('hidden/decodes-single-chunk', () => {
  const decoder = new StreamDecoder();
  assert.equal(decoder.push(encode('订单已创建')), '订单已创建');
  assert.equal(decoder.end(), '');
  assert.equal(decoder.offset, encode('订单已创建').length);
});

test('hidden/decodes-character-split-across-chunks', () => {
  const decoder = new StreamDecoder();
  const bytes = encode('中');
  assert.equal(decoder.push(bytes.slice(0, 1)), '');
  assert.equal(decoder.push(bytes.slice(1, 2)), '');
  assert.equal(decoder.push(bytes.slice(2)), '中');
  assert.equal(decoder.end(), '');
});

test('hidden/decodes-four-byte-emoji-in-two-parts', () => {
  const decoder = new StreamDecoder();
  const bytes = encode('a🚀b');
  const split = bytes.length - 3;
  assert.equal(decoder.push(bytes.slice(0, split)), 'a');
  assert.equal(decoder.push(bytes.slice(split)), '🚀b');
});

test('hidden/rejects-invalid-bytes', () => {
  const decoder = new StreamDecoder();
  assert.equal(failureOf(() => decoder.push(new Uint8Array([0xff, 0xfe]))), 'invalid:0');
  const second = new StreamDecoder();
  second.push(encode('ok'));
  assert.equal(failureOf(() => second.push(new Uint8Array([0x80]))), 'invalid:2');
});

test('hidden/end-reports-incomplete-sequence', () => {
  const decoder = new StreamDecoder();
  assert.equal(decoder.push(encode('中').slice(0, 2)), '');
  assert.equal(failureOf(() => decoder.end()), 'incomplete');
});
