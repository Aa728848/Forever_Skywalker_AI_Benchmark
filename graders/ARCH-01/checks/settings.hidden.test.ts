import test from 'node:test';
import assert from 'node:assert/strict';
import { SettingsError, resolveSettings, type HostPort } from '../starter/src/settings.ts';

function portOf(values: Record<string, string | null>): HostPort {
  return { readSetting: key => (key in values ? (values[key] as string | null) : null) };
}

test('hidden/reads-everything-through-the-port', () => {
  const previous = { mode: process.env.APP_MODE, endpoint: process.env.APP_ENDPOINT };
  process.env.APP_MODE = 'dev';
  process.env.APP_ENDPOINT = 'http://wrong.example';
  try {
    const settings = resolveSettings(portOf({ endpoint: 'http://port-only.example' }));
    assert.deepEqual(settings, { mode: 'dev', endpoint: 'http://port-only.example', retries: 3 });
  } finally {
    if (previous.mode === undefined) delete process.env.APP_MODE; else process.env.APP_MODE = previous.mode;
    if (previous.endpoint === undefined) delete process.env.APP_ENDPOINT; else process.env.APP_ENDPOINT = previous.endpoint;
  }
});

test('hidden/no-module-level-cache', () => {
  const values: Record<string, string | null> = { mode: 'dev', endpoint: 'http://a', retries: null };
  const port: HostPort = { readSetting: key => values[key] ?? null };
  assert.equal(resolveSettings(port).endpoint, 'http://a');
  values.endpoint = 'http://b';
  assert.equal(resolveSettings(port).endpoint, 'http://b');
  values.mode = 'prod';
  assert.equal(resolveSettings(port).mode, 'prod');
});

test('hidden/defaults-and-validation', () => {
  assert.equal(resolveSettings(portOf({ endpoint: 'http://a' })).retries, 3);
  assert.equal(resolveSettings(portOf({ endpoint: 'http://a' })).mode, 'dev');
  assert.throws(() => resolveSettings(portOf({})), (error: unknown) => error instanceof SettingsError && error.key === 'endpoint');
  assert.throws(() => resolveSettings(portOf({ endpoint: '   ' })), SettingsError);
  assert.throws(() => resolveSettings(portOf({ endpoint: 'http://a', retries: '11' })), (error: unknown) => error instanceof SettingsError && error.key === 'retries');
  assert.throws(() => resolveSettings(portOf({ endpoint: 'http://a', retries: 'x' })), SettingsError);
  assert.equal(resolveSettings(portOf({ endpoint: 'http://a', retries: '0' })).retries, 0);
});

test('hidden/result-is-frozen', () => {
  const settings = resolveSettings(portOf({ endpoint: 'http://a' }));
  assert.equal(Object.isFrozen(settings), true);
  assert.throws(() => { (settings as { endpoint: string }).endpoint = 'http://b'; });
});

test('hidden/does-not-mutate-port', () => {
  const calls: string[] = [];
  const port: HostPort = { readSetting: key => { calls.push(key); return key === 'endpoint' ? 'http://a' : null; } };
  resolveSettings(port);
  assert.deepEqual([...calls].sort(), ['endpoint', 'mode', 'retries']);
  assert.deepEqual(Object.keys(port), ['readSetting']);
});
