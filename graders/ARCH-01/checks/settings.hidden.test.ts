import test from 'node:test';
import assert from 'node:assert/strict';
import { SettingsError, resolveSettings, type HostPort, type Settings } from '../starter/src/settings.ts';

function portOf(values: Record<string, string | null>): HostPort {
  return { readSetting: key => (key in values ? (values[key] as string | null) : null) };
}

test('hidden/port-wins-over-host-globals', () => {
  // 端口缺省值必须压过宿主全局：直接读 process.env 的实现在此必然拿错 mode/endpoint。
  const previous = { mode: process.env.APP_MODE, endpoint: process.env.APP_ENDPOINT, retries: process.env.APP_RETRIES };
  process.env.APP_MODE = 'prod';
  process.env.APP_ENDPOINT = 'http://host-only.example';
  process.env.APP_RETRIES = '9';
  try {
    // 端口未提供 mode/retries：必须取契约缺省，而不是宿主的 prod / 9。
    const settings = resolveSettings(portOf({ endpoint: 'http://port-only.example' }));
    assert.deepEqual(settings, { mode: 'dev', endpoint: 'http://port-only.example', retries: 3 });
    // 端口显式提供时同样以端口为准。
    const explicit = resolveSettings(portOf({ mode: 'prod', endpoint: 'http://port-only.example', retries: '0' }));
    assert.deepEqual(explicit, { mode: 'prod', endpoint: 'http://port-only.example', retries: 0 });
  } finally {
    if (previous.mode === undefined) delete process.env.APP_MODE; else process.env.APP_MODE = previous.mode;
    if (previous.endpoint === undefined) delete process.env.APP_ENDPOINT; else process.env.APP_ENDPOINT = previous.endpoint;
    if (previous.retries === undefined) delete process.env.APP_RETRIES; else process.env.APP_RETRIES = previous.retries;
  }
});

test('hidden/cache-is-per-call-not-per-module', () => {
  // 同一个端口对象连续解析，值改变后必须立刻生效——模块级缓存会停在第一次。
  const values: Record<string, string | null> = { mode: 'prod', endpoint: 'http://a', retries: null };
  const port: HostPort = { readSetting: key => values[key] ?? null };
  const first = resolveSettings(port);
  const second = resolveSettings(port);
  assert.notEqual(first, second, '两次解析必须返回不同对象，不能是同一份缓存');
  values.endpoint = 'http://b';
  assert.equal(resolveSettings(port).endpoint, 'http://b');
  values.retries = '7';
  assert.equal(resolveSettings(port).retries, 7);
  // 另一个端口对象不能继承上一个端口的缓存。
  assert.equal(resolveSettings(portOf({ endpoint: 'http://c' })).endpoint, 'http://c');
});

test('hidden/mode-accepts-only-exact-prod', () => {
  // 契约：只有字面量 'prod' 是 prod，其余一切（含大小写、带空白）都取 dev。
  for (const value of ['prod']) {
    assert.equal(resolveSettings(portOf({ mode: value, endpoint: 'http://a' })).mode, 'prod', value);
  }
  for (const value of ['PROD', 'Prod', ' prod', 'prod ', 'production', 'dev', '', '0']) {
    assert.equal(resolveSettings(portOf({ mode: value, endpoint: 'http://a' })).mode, 'dev', JSON.stringify(value));
  }
  assert.equal(resolveSettings(portOf({ endpoint: 'http://a' })).mode, 'dev', '缺省取 dev');
});

test('hidden/endpoint-rejects-every-blank-form', () => {
  // 空白判定必须覆盖 tab/换行/不换行空格/全角空白，而不只是 ASCII 空格。
  for (const value of ['', ' ', '   ', '\t', '\n', '\r\n', '\u00a0', '\u3000', ' \t\n ']) {
    assert.throws(
      () => resolveSettings(portOf({ endpoint: value })),
      (error: unknown) => error instanceof SettingsError && error.key === 'endpoint',
      'endpoint=' + JSON.stringify(value),
    );
  }
  // endpoint 缺失（端口返回 null）同样以 'endpoint' 为 key。
  assert.throws(
    () => resolveSettings(portOf({})),
    (error: unknown) => error instanceof SettingsError && error.key === 'endpoint',
  );
  // 合法的非 ASCII 端点不得被空白检查误杀。
  assert.equal(resolveSettings(portOf({ endpoint: 'http://例子.example/路径' })).endpoint, 'http://例子.example/路径');
});

test('hidden/retries-range-and-format', () => {
  // 0 与 10 都是合法边界。
  assert.equal(resolveSettings(portOf({ endpoint: 'http://a', retries: '0' })).retries, 0);
  assert.equal(resolveSettings(portOf({ endpoint: 'http://a', retries: '10' })).retries, 10);
  // 越界与非法格式都以 'retries' 为 key。
  for (const value of ['-1', '11', '100', '3.0', '3.5', '0x3', '1e1', ' 3', '3 ', '+3', 'abc', '', '\t', '０', 'Infinity', 'NaN']) {
    assert.throws(
      () => resolveSettings(portOf({ endpoint: 'http://a', retries: value })),
      (error: unknown) => error instanceof SettingsError && error.key === 'retries',
      'retries=' + JSON.stringify(value),
    );
  }
  // 缺省 3。
  assert.equal(resolveSettings(portOf({ endpoint: 'http://a' })).retries, 3);
});

test('hidden/validation-precedence-and-single-read-per-key', () => {
  // 端口必须只被问一次：重复读取会让有副作用的宿主实现拿到不一致的值。
  const counts: Record<string, number> = { mode: 0, endpoint: 0, retries: 0 };
  let endpointCalls = 0;
  const port: HostPort = {
    readSetting: key => {
      counts[key] = (counts[key] ?? 0) + 1;
      if (key === 'endpoint') {
        endpointCalls += 1;
        return endpointCalls === 1 ? 'http://a' : 'http://changed';
      }
      return null;
    },
  };
  const settings = resolveSettings(port);
  assert.equal(settings.endpoint, 'http://a', '第二次读到不同值说明重复读取了 endpoint');
  assert.deepEqual(counts, { mode: 1, endpoint: 1, retries: 1 });
});

test('hidden/returned-object-is-frozen-and-detached', () => {
  const settings: Settings = resolveSettings(portOf({ endpoint: 'http://a', retries: '5' }));
  assert.equal(Object.isFrozen(settings), true);
  for (const key of ['mode', 'endpoint', 'retries'] as const) {
    assert.throws(() => { (settings as Record<string, unknown>)[key] = 'mutated'; }, TypeError, key);
  }
  // 冻结是逐次成立的：前一次的冻结不能让后一次拿到同一个对象。
  const other = resolveSettings(portOf({ endpoint: 'http://b' }));
  assert.notEqual(settings, other);
  assert.equal(other.endpoint, 'http://b');
  assert.equal(settings.endpoint, 'http://a', '不同端口的解析不得互相污染');
});

test('hidden/port-object-is-never-mutated', () => {
  // 端口是带状态的对象；实现只允许调用 readSetting，不得给端口加字段或改写已有属性。
  const port: HostPort = {
    readSetting: key => (key === 'endpoint' ? 'http://a' : null),
    retries: '2',
  } as unknown as HostPort;
  const before = Object.keys(port).sort();
  const settings = resolveSettings(port);
  assert.equal(settings.endpoint, 'http://a');
  assert.equal(settings.retries, 3, '端口上的同名字段不是配置来源，仍取契约缺省');
  assert.deepEqual(Object.keys(port).sort(), before, '实现给端口新增了字段');
  assert.equal((port as unknown as { retries: string }).retries, '2', '实现改写了端口上的属性');
});
