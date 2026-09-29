import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestError, validateOrderRequest } from '../starter/src/request.ts';

type Issue = { field: string; code: string };

/** 返回 RequestError.issues；未抛错时返回 null。 */
function issuesOf(payload: unknown): Issue[] | null {
  try {
    validateOrderRequest(payload);
    return null;
  } catch (error) {
    assert.equal(error instanceof RequestError, true, '不是 RequestError：' + String(error));
    assert.equal((error as RequestError).status, 400, 'status 必须是 400');
    return (error as RequestError).issues as Issue[];
  }
}

test('hidden/quantity-must-be-integer-in-1-to-1000', () => {
  // 契约第 4 条：1..1000 的整数。0 是 range（不是合法值），非整数是 type。
  assert.deepEqual(issuesOf({ orderId: 'o', quantity: 1 }), null);
  assert.deepEqual(issuesOf({ orderId: 'o', quantity: 1000 }), null);
  assert.deepEqual(issuesOf({ orderId: 'o', quantity: 500 }), null);
  // 下界 0 报 range。
  assert.deepEqual(issuesOf({ orderId: 'o', quantity: 0 }), [{ field: 'quantity', code: 'range' }]);
  // 非整数报 type 而非 range。
  for (const value of [1.5, 0.5, 999.999, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.deepEqual(issuesOf({ orderId: 'o', quantity: value }), [{ field: 'quantity', code: 'type' }],
      'quantity=' + String(value));
  }
  // 数字字符串一律 type，不做隐式转换。
  for (const value of ['5', '0', '1000', '', ' ', '1e3']) {
    assert.deepEqual(issuesOf({ orderId: 'o', quantity: value }), [{ field: 'quantity', code: 'type' }],
      'quantity=' + JSON.stringify(value));
  }
  // 布尔、null、对象、数组都是 type。
  for (const value of [true, false, null, {}, [], [1], Symbol('s')]) {
    assert.deepEqual(issuesOf({ orderId: 'o', quantity: value }), [{ field: 'quantity', code: 'type' }],
      'quantity=' + String(value));
  }
  // 负数与超界是 range。
  for (const value of [-1, -100, 1001, 5000]) {
    assert.deepEqual(issuesOf({ orderId: 'o', quantity: value }), [{ field: 'quantity', code: 'range' }],
      'quantity=' + String(value));
  }
});

test('hidden/order-id-must-be-non-empty-string', () => {
  // 契约第 3 条：必填且非空字符串。缺失是 missing，类型错/空白是 type。
  assert.deepEqual(issuesOf({ quantity: 1 }), [{ field: 'orderId', code: 'missing' }]);
  assert.deepEqual(issuesOf({ orderId: undefined, quantity: 1 }), [{ field: 'orderId', code: 'missing' }]);
  for (const value of ['', ' ', '  \t  ', '\n', 0, 1, true, null, {}, []]) {
    assert.deepEqual(issuesOf({ orderId: value, quantity: 1 }), [{ field: 'orderId', code: 'type' }],
      'orderId=' + JSON.stringify(value));
  }
  // 纯空白算非法；含可见字符的合法。
  assert.deepEqual(issuesOf({ orderId: ' a ', quantity: 1 }), null, '首尾空白被当成了空');
  assert.deepEqual(issuesOf({ orderId: '订单-1', quantity: 1 }), null);
});

test('hidden/note-optional-but-when-present-strict', () => {
  // 契约第 5 条：可选；提供时必须非空字符串且长度 ≤ 200。
  assert.deepEqual(issuesOf({ orderId: 'o', quantity: 1 }), null, '缺省 note 应通过');
  assert.deepEqual(issuesOf({ orderId: 'o', quantity: 1, note: 'x' }), null);
  assert.deepEqual(validateOrderRequest({ orderId: 'o', quantity: 1, note: 'x' }).note, 'x');
  // 长度边界：200 合法，201 非法。
  assert.deepEqual(issuesOf({ orderId: 'o', quantity: 1, note: 'x'.repeat(200) }), null, '长度 200 被判非法');
  assert.deepEqual(issuesOf({ orderId: 'o', quantity: 1, note: 'x'.repeat(201) }), [{ field: 'note', code: 'type' }]);
  // 空串与纯空白非法。
  for (const value of ['', ' ', '\t', 0, 5, true, null, {}, []]) {
    assert.deepEqual(issuesOf({ orderId: 'o', quantity: 1, note: value }), [{ field: 'note', code: 'type' }],
      'note=' + JSON.stringify(value));
  }
  // note 为 undefined 等同未提供。
  assert.deepEqual(issuesOf({ orderId: 'o', quantity: 1, note: undefined }), null);
});

test('hidden/issue-order-is-stable-and-complete', () => {
  // 契约第 6 条：先未知字段（JS 默认字符串顺序升序），再 orderId、quantity、note。
  const issues = issuesOf({
    zeta: 1, alpha: 2, orderId: '', quantity: 5000, note: 'x'.repeat(201), mid: 3,
  });
  assert.deepEqual(issues, [
    { field: 'alpha', code: 'unknown-field' },
    { field: 'mid', code: 'unknown-field' },
    { field: 'zeta', code: 'unknown-field' },
    { field: 'orderId', code: 'type' },
    { field: 'quantity', code: 'range' },
    { field: 'note', code: 'type' },
  ]);
  // 同一输入多次调用必须得到完全一致的顺序。
  const payload = { b: 1, a: 2, orderId: '', quantity: 0 };
  const first = JSON.stringify(issuesOf(payload));
  for (let i = 0; i < 3; i += 1) assert.equal(JSON.stringify(issuesOf(payload)), first, '顺序不稳定');
  // 一次返回**全部**问题，不得只报第一个。
  assert.equal(issues!.length, 6, '没有收集到全部问题');
});

test('hidden/unknown-fields-including-prototype-names', () => {
  // 契约第 2 条 + 末段：只校验自身可枚举字符串字段。
  assert.deepEqual(issuesOf({ orderId: 'o', quantity: 1, extra: 1 }), [{ field: 'extra', code: 'unknown-field' }]);
  // 多个未知字段全部报出，按升序。
  assert.deepEqual(issuesOf({ orderId: 'o', quantity: 1, z: 1, a: 1, m: 1 }),
    [{ field: 'a', code: 'unknown-field' }, { field: 'm', code: 'unknown-field' }, { field: 'z', code: 'unknown-field' }]);
  // 未知字段的值为 undefined 时也算未知字段。
  assert.deepEqual(issuesOf({ orderId: 'o', quantity: 1, ghost: undefined }), [{ field: 'ghost', code: 'unknown-field' }]);
  // 符号键不在「可枚举字符串字段」范围内，不报。
  const withSymbol = { orderId: 'o', quantity: 1, [Symbol('s')]: 1 };
  assert.deepEqual(issuesOf(withSymbol), null, '符号键被当成了未知字段');
  // 不可枚举属性同样不在校验范围。
  const hiddenProp = { orderId: 'o', quantity: 1 };
  Object.defineProperty(hiddenProp, 'secret', { value: 1, enumerable: false });
  assert.deepEqual(issuesOf(hiddenProp), null, '不可枚举属性被当成了未知字段');
  // 自身可枚举但值为 undefined 的已知字段，仍按缺失/类型处理。
  assert.deepEqual(issuesOf({ orderId: undefined, quantity: 1 }), [{ field: 'orderId', code: 'missing' }]);
});

test('hidden/non-plain-payloads-rejected', () => {
  // 契约第 1 条 + 末段：原型为 Object.prototype 或 null 的对象才算普通对象。
  for (const payload of [null, undefined, 0, 1, '', 'x', true, Symbol('s'), 10n, [], [1, 2], () => 1]) {
    assert.deepEqual(issuesOf(payload), [{ field: '', code: 'type' }], String(payload));
  }
  // 原型为 null 的对象是合法的普通对象。
  const nullProto = Object.assign(Object.create(null), { orderId: 'o', quantity: 1 });
  assert.deepEqual(issuesOf(nullProto), null, 'null 原型对象被拒绝');
  assert.deepEqual(validateOrderRequest(nullProto), { orderId: 'o', quantity: 1 });
  // Date、带自定义原型的对象、类实例都拒绝。
  class Payload { orderId = 'a'; quantity = 1; }
  for (const payload of [new Payload(), new Date(), Object.create({ orderId: 'a', quantity: 1 })]) {
    assert.deepEqual(issuesOf(payload), [{ field: '', code: 'type' }], String(payload));
  }
  // 数组即使带合法字段也不是普通对象。
  const arrayLike = Object.assign(['x'], { orderId: 'a', quantity: 1 });
  assert.deepEqual(issuesOf(arrayLike), [{ field: '', code: 'type' }]);
});

test('hidden/result-is-frozen-and-detached', () => {
  // 契约第 7 条：返回冻结对象，且不是传入的那个对象。
  const input = { orderId: 'o-1', quantity: 2 };
  const result = validateOrderRequest(input);
  assert.notEqual(result, input, '返回了调用方传入的对象');
  assert.equal(Object.isFrozen(result), true, '结果未冻结');
  assert.throws(() => { (result as { orderId: string }).orderId = 'changed'; });
  // 修改入参不影响已返回的结果。
  input.quantity = 99;
  assert.equal(result.quantity, 2, '结果与入参共享引用');
  // 带 note 时同样冻结且独立。
  const withNote = validateOrderRequest({ orderId: 'o', quantity: 1, note: 'n' });
  assert.equal(Object.isFrozen(withNote), true);
  assert.equal(withNote.note, 'n');
  // 重复调用返回不同对象。
  const a = validateOrderRequest({ orderId: 'o', quantity: 1 });
  const b = validateOrderRequest({ orderId: 'o', quantity: 1 });
  assert.notEqual(a, b, '两次调用返回了同一对象');
  assert.deepEqual(a, b);
});

test('hidden/error-shape-and-message-are-stable', () => {
  let failure: RequestError | null = null;
  try {
    validateOrderRequest({});
  } catch (error) {
    assert.equal(error instanceof RequestError, true, '不是 RequestError：' + String(error));
    failure = error as RequestError;
  }
  assert.notEqual(failure, null, '空载荷本应抛出 RequestError');
  assert.equal(failure!.name, 'RequestError');
  assert.equal(failure!.status, 400);
  assert.equal(failure! instanceof Error, true, 'RequestError 必须是 Error');
  assert.equal(Array.isArray(failure!.issues), true);
  // 抛错后再抛一次：两次的 issues 不得互相影响。
  const collected: string[] = [];
  for (const payload of [{}, { orderId: '', quantity: 0 }]) {
    try {
      validateOrderRequest(payload);
    } catch (error) {
      collected.push(JSON.stringify((error as RequestError).issues));
    }
  }
  assert.equal(collected.length, 2, '两次调用都应抛出 RequestError');
  assert.notEqual(collected[0], collected[1], '两次抛错的 issues 相同，说明可能有共享状态');
});
