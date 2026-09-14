import test from 'node:test';
import assert from 'node:assert/strict';
import { CliUsageError, parseCli } from '../starter/src/cli.ts';

const defaults = { host: '127.0.0.1', port: 8080, tag: 'stable', verbose: false };

function failure(argv: string[]) {
  try { parseCli(argv, defaults); return null; } catch (error) {
    return error instanceof CliUsageError ? { option: error.option } : { option: 'unexpected' };
  }
}

test('hidden/uses-defaults', () => {
  assert.deepEqual(parseCli([], defaults), { ...defaults, rest: [] });
});

test('hidden/accepts-both-value-forms', () => {
  assert.equal(parseCli(['--host=0.0.0.0'], defaults).host, '0.0.0.0');
  assert.equal(parseCli(['--host', '0.0.0.0'], defaults).host, '0.0.0.0');
});

test('hidden/zero-and-empty-are-values', () => {
  assert.equal(parseCli(['--port', '0'], defaults).port, 0);
  assert.equal(parseCli(['--tag', ''], defaults).tag, '');
});

test('hidden/rejects-unknown-option', () => {
  assert.deepEqual(failure(['--nope', 'x']), { option: 'nope' });
});

test('hidden/rejects-missing-value-and-bad-port', () => {
  assert.deepEqual(failure(['--host']), { option: 'host' });
  assert.deepEqual(failure(['--port', 'abc']), { option: 'port' });
  assert.deepEqual(failure(['--port', '65536']), { option: 'port' });
  assert.equal(parseCli(['--port', '65535'], defaults).port, 65535);
});

test('hidden/last-value-wins', () => {
  assert.equal(parseCli(['--tag', 'a', '--tag=b'], defaults).tag, 'b');
});

test('hidden/collects-positionals-around-separator', () => {
  assert.deepEqual(parseCli(['run', '--host', 'h', 'file.txt', '--', '--not-an-option', '-x'], defaults).rest, ['run', 'file.txt', '--not-an-option', '-x']);
});

test('hidden/boolean-switches', () => {
  assert.equal(parseCli(['--verbose'], defaults).verbose, true);
  assert.equal(parseCli(['--verbose', '--no-verbose'], defaults).verbose, false);
  assert.deepEqual(failure(['--verbose=true']), { option: 'verbose' });
});
