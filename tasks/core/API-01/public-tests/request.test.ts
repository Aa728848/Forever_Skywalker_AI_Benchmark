import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestError, validateOrderRequest } from '../starter/src/request.ts';

function issuesOf(payload: unknown) {
  try {
    validateOrderRequest(payload);
    return null;
  } catch (error) {
    return error instanceof RequestError ? error.issues : [{ field: 'unexpected', code: String(error) }];
  }
}

test('public/accepts-valid-request', () => {
  assert.deepEqual(validateOrderRequest({ orderId: 'o-1', quantity: 1 }), { orderId: 'o-1', quantity: 1 });
  assert.deepEqual(validateOrderRequest({ orderId: 'o-2', quantity: 1000, note: '备注' }), { orderId: 'o-2', quantity: 1000, note: '备注' });
});

test('public/reports-missing-fields', () => {
  const issues = issuesOf({});
  assert.deepEqual(issues, [{ field: 'orderId', code: 'missing' }, { field: 'quantity', code: 'missing' }]);
});

test('public/rejects-numeric-strings', () => {
  const issues = issuesOf({ orderId: 'o-1', quantity: '5' });
  assert.deepEqual(issues, [{ field: 'quantity', code: 'type' }]);
});

test('public/quantity-range-boundaries', () => {
  assert.deepEqual(issuesOf({ orderId: 'o', quantity: 0 }), [{ field: 'quantity', code: 'range' }]);
  assert.deepEqual(issuesOf({ orderId: 'o', quantity: 1001 }), [{ field: 'quantity', code: 'range' }]);
  assert.deepEqual(issuesOf({ orderId: 'o', quantity: 1 }), null);
  assert.deepEqual(issuesOf({ orderId: 'o', quantity: 1000 }), null);
  assert.deepEqual(issuesOf({ orderId: 'o', quantity: 1.5 }), [{ field: 'quantity', code: 'type' }]);
});

test('public/rejects-unknown-fields', () => {
  assert.deepEqual(issuesOf({ orderId: 'o', quantity: 1, extra: true }), [{ field: 'extra', code: 'unknown-field' }]);
});

test('public/collects-every-issue', () => {
  const issues = issuesOf({ orderId: '', quantity: 5000, note: 'x'.repeat(201), unknown: 1 });
  assert.deepEqual(issues, [
    { field: 'unknown', code: 'unknown-field' },
    { field: 'orderId', code: 'type' },
    { field: 'quantity', code: 'range' },
    { field: 'note', code: 'type' },
  ]);
});

test('public/rejects-non-object-payload', () => {
  assert.deepEqual(issuesOf(null), [{ field: '', code: 'type' }]);
  assert.deepEqual(issuesOf([]), [{ field: '', code: 'type' }]);
  assert.deepEqual(issuesOf('x'), [{ field: '', code: 'type' }]);
});

test('public/returns-frozen-copy', () => {
  const input = { orderId: 'o-1', quantity: 2 };
  const result = validateOrderRequest(input);
  assert.notEqual(result, input);
  assert.equal(Object.isFrozen(result), true);
  input.quantity = 99;
  assert.equal(result.quantity, 2);
});
