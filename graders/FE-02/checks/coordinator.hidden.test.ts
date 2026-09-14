import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestCoordinator, SupersededError, type RequestPort } from '../starter/src/coordinator.ts';

interface Call {
  readonly key: string;
  readonly payload: string;
  readonly signal: AbortSignal;
  readonly resolve: (value: string) => void;
  readonly reject: (error: unknown) => void;
}

function fakePort() {
  const calls: Call[] = [];
  const port: RequestPort = {
    send(key, payload, signal) {
      return new Promise<string>((resolve, reject) => {
        calls.push({ key, payload, signal, resolve, reject });
      });
    },
  };
  return {
    port,
    calls,
    forKey: (key: string) => calls.filter(call => call.key === key),
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<string> {
  try { await promise; return 'resolved'; } catch (error) {
    if (error instanceof SupersededError) return 'superseded:' + error.key;
    return 'other:' + String(error);
  }
}

test('hidden/supersedes-previous-request', async () => {
  const fake = fakePort();
  const coordinator = new RequestCoordinator(fake.port);
  const first = coordinator.request('a', 'v1');
  const second = coordinator.request('a', 'v2');
  fake.calls[0]?.resolve('v1');
  assert.equal(await rejectionOf(first), 'superseded:a');
  assert.equal(fake.calls[0]?.signal.aborted, true);
  assert.equal(coordinator.pending, 1);
  assert.equal(fake.calls.length, 2);
  fake.calls[1]?.resolve('v2');
  assert.equal(await second, 'v2');
  assert.equal(coordinator.pending, 0);
});

test('hidden/keeps-newest-result-even-out-of-order', async () => {
  const fake = fakePort();
  const coordinator = new RequestCoordinator(fake.port);
  const first = coordinator.request('k', 'old');
  const second = coordinator.request('k', 'new');
  fake.calls[1]?.resolve('new');
  assert.equal(await second, 'new');
  fake.calls[0]?.resolve('old');
  assert.equal(await rejectionOf(first), 'superseded:k');
});

test('hidden/different-keys-are-independent', async () => {
  const fake = fakePort();
  const coordinator = new RequestCoordinator(fake.port);
  const alpha = coordinator.request('alpha', 'a');
  const beta = coordinator.request('beta', 'b');
  assert.equal(coordinator.pending, 2);
  fake.forKey('beta')[0]?.resolve('B');
  assert.equal(await beta, 'B');
  assert.equal(coordinator.pending, 1);
  fake.forKey('alpha')[0]?.resolve('A');
  assert.equal(await alpha, 'A');
  assert.equal(coordinator.pending, 0);
});

test('hidden/settles-pending-on-failure', async () => {
  const fake = fakePort();
  const coordinator = new RequestCoordinator(fake.port);
  const boom = new Error('端口失败');
  const failed = coordinator.request('x', 'v');
  fake.forKey('x')[0]?.reject(boom);
  assert.equal(await rejectionOf(failed), 'other:Error: 端口失败');
  assert.equal(coordinator.pending, 0);
});

test('hidden/cancel-all-rejects-and-aborts', async () => {
  const fake = fakePort();
  const coordinator = new RequestCoordinator(fake.port);
  const alpha = coordinator.request('alpha', 'a');
  const beta = coordinator.request('beta', 'b');
  coordinator.cancelAll();
  assert.equal(coordinator.pending, 0);
  assert.deepEqual(fake.calls.map(call => call.signal.aborted), [true, true]);
  assert.equal(await rejectionOf(alpha), 'superseded:alpha');
  assert.equal(await rejectionOf(beta), 'superseded:beta');
  fake.calls[0]?.resolve('late');
  assert.equal(await rejectionOf(alpha), 'superseded:alpha');
});
