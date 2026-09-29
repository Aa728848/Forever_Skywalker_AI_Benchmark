import test from 'node:test';
import assert from 'node:assert/strict';
import { InvalidSnapshotError, UnknownStateError, UnsupportedVersionError, migrate, orderStates } from '../starter/src/snapshot.ts';

function failureOf(run: () => unknown): string {
  try { run(); return 'ok'; } catch (error) {
    if (error instanceof UnsupportedVersionError) return 'version:' + error.version;
    if (error instanceof UnknownStateError) return 'state:' + error.state;
    if (error instanceof InvalidSnapshotError) return 'invalid';
    return 'other:' + String(error);
  }
}

test('hidden/v2-accepts-only-exact-state-names', () => {
  // 契约第 1 条：state 必须是合法状态名，合法时原样返回。
  for (const state of orderStates) {
    assert.deepEqual(migrate({ version: 2, state }), { version: 2, state }, state);
  }
  // 旧版本状态名在 v2 下不合法（不得被当成 v1 兼容处理）。
  for (const state of ['new', 'active', 'done', 'DRAFT', 'Draft', 'paid ', ' paid', '']) {
    assert.equal(failureOf(() => migrate({ version: 2, state })), 'invalid', 'version=2 state=' + JSON.stringify(state));
  }
  // 缺失或类型错误。
  assert.equal(failureOf(() => migrate({ version: 2 })), 'invalid');
  for (const state of [null, 0, 1, true, {}, [], ['paid']]) {
    assert.equal(failureOf(() => migrate({ version: 2, state })), 'invalid', String(state));
  }
  // 返回的是新对象，不是传入的那个。
  const input = { version: 2, state: 'paid' };
  assert.notEqual(migrate(input), input, 'v2 返回了传入的对象');
  // 额外的未知字段不参与校验，也不应被带入结果。
  assert.deepEqual(migrate({ version: 2, state: 'paid', extra: 1 }), { version: 2, state: 'paid' });
});

test('hidden/v1-maps-only-the-frozen-names', () => {
  // 契约第 2 条：冻结映射 new→draft、active→placed、done→shipped。
  const mapping: Array<[string, string]> = [['new', 'draft'], ['active', 'placed'], ['done', 'shipped']];
  for (const [status, state] of mapping) {
    assert.deepEqual(migrate({ version: 1, status }), { version: 2, state }, status);
  }
  // 映射表外的旧名抛 UnknownStateError，state 是旧名本身。
  for (const status of ['cancelled', 'canceled', 'NEW', 'Done', '', 'shipped', 'paid']) {
    assert.equal(failureOf(() => migrate({ version: 1, status })), 'state:' + status, 'status=' + JSON.stringify(status));
  }
  // v1 快照里的 v2 状态名也不是合法旧名。
  assert.equal(failureOf(() => migrate({ version: 1, status: 'draft' })), 'state:draft');
  // v1 缺 status 是结构错误，不是未知状态。
  assert.equal(failureOf(() => migrate({ version: 1 })), 'invalid');
  assert.equal(failureOf(() => migrate({ version: 1, state: 'paid' })), 'invalid', 'v1 用了 v2 字段');
  for (const status of [null, 0, true, {}, []]) {
    assert.equal(failureOf(() => migrate({ version: 1, status })), 'invalid', String(status));
  }
});

test('hidden/unsupported-versions-stringify-exactly', () => {
  // 契约第 3 条：其它版本抛 UnsupportedVersionError，version 为 String(原始值)。
  // 注意：1 是**受支持**的版本（契约第 2 条），不能列入这里。
  for (const version of [0, 3, 99, -1, 2.5, '2', 'v2', true, null]) {
    const failure = failureOf(() => migrate({ version, state: 'paid' }));
    assert.equal(failure, 'version:' + String(version), 'version=' + String(version));
  }
  // 缺 version 时是字符串 'undefined'。
  assert.equal(failureOf(() => migrate({ state: 'paid' })), 'version:undefined');
  assert.equal(failureOf(() => migrate({})), 'version:undefined');
  // 数组不是合法快照：但契约第 4 条说非对象抛 InvalidSnapshotError，
  // 数组是对象，所以走版本判定——没有 version 即 'undefined'。
  assert.equal(failureOf(() => migrate([])), 'version:undefined');
  // 版本判定优先于状态判定：v3 + 非法状态，仍报版本错误。
  assert.equal(failureOf(() => migrate({ version: 3, state: 'nonsense' })), 'version:3');
});

test('hidden/non-object-inputs-are-invalid', () => {
  // 契约第 4 条：非对象输入抛 InvalidSnapshotError。
  for (const raw of [null, undefined, 0, 1, -1, NaN, '', 'x', true, false, Symbol('s'), 10n, () => 1]) {
    assert.equal(failureOf(() => migrate(raw)), 'invalid', String(raw));
  }
  // 对象路径不受影响。
  assert.deepEqual(migrate({ version: 2, state: 'shipped' }), { version: 2, state: 'shipped' });
});

test('hidden/migration-is-idempotent-for-every-state', () => {
  // 契约第 5 条：migrate(migrate(x)) 与 migrate(x) 相同。
  for (const state of orderStates) {
    const once = migrate({ version: 2, state });
    assert.deepEqual(migrate(once), once, state);
    assert.deepEqual(migrate(migrate(once)), once, state);
  }
  // 三个旧状态迁移后再迁移也必须稳定。
  for (const status of ['new', 'active', 'done']) {
    const once = migrate({ version: 1, status });
    assert.equal(once.version, 2);
    assert.deepEqual(migrate(once), once, status);
    assert.deepEqual(migrate(migrate(once)), once, status);
  }
  // 重复迁移不得改变已迁移结果的状态。
  const shipped = migrate({ version: 1, status: 'done' });
  assert.equal(shipped.state, 'shipped');
  assert.equal(migrate(shipped).state, 'shipped');
});
