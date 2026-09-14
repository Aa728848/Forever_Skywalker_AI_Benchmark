import test from 'node:test';
import assert from 'node:assert/strict';
import { GroupCancelledError, TaskGroup } from '../starter/src/group.ts';

/** 可控成员：收到 abort 时结算，保证检查不会挂住。 */
function controllable() {
  const aborted: string[] = [];
  const finishes: (() => void)[] = [];
  const work = (id: string) => (signal: AbortSignal) => {
    return new Promise<string>((resolve, reject) => {
      signal.addEventListener('abort', () => { aborted.push(id); reject(new Error('aborted:' + id)); });
      finishes.push(() => resolve('done:' + id));
    });
  };
  return { work, aborted, finishes };
}

async function rejectionOf(promise: Promise<unknown>): Promise<string> {
  try { await promise; return 'resolved'; } catch (error) {
    if (error instanceof GroupCancelledError) return 'cancelled:' + error.pending.join(',');
    return 'other:' + String(error);
  }
}

test('public/runs-and-settles-members', async () => {
  const group = new TaskGroup();
  const control = controllable();
  const first = group.run('a', control.work('a'));
  const second = group.run('b', control.work('b'));
  assert.deepEqual(group.active, ['a', 'b']);
  control.finishes[1]?.();
  assert.equal(await second, 'done:b');
  assert.deepEqual(group.active, ['a']);
  control.finishes[0]?.();
  assert.equal(await first, 'done:a');
  assert.deepEqual(group.active, []);
});

test('public/cancel-all-aborts-every-member', async () => {
  const group = new TaskGroup();
  const control = controllable();
  const first = group.run('a', control.work('a'));
  const second = group.run('b', control.work('b'));
  await group.cancelAll();
  assert.deepEqual(control.aborted.sort(), ['a', 'b']);
  assert.deepEqual(group.active, []);
  assert.equal(await rejectionOf(first), 'cancelled:a,b');
  assert.equal(await rejectionOf(second), 'cancelled:a,b');
});

test('public/cancel-all-waits-for-settlements', async () => {
  const group = new TaskGroup();
  const control = controllable();
  let settled = false;
  const member = group.run('a', control.work('a'));
  void member.catch(() => { settled = true; });
  await group.cancelAll();
  await Promise.resolve();
  assert.equal(settled, true, 'cancelAll 兑现时全部成员必须已经结算');
});

test('public/cancel-all-is-noop-without-members', async () => {
  const group = new TaskGroup();
  const control = controllable();
  await group.cancelAll();
  assert.deepEqual(control.aborted, []);
  assert.deepEqual(group.active, []);
});

test('public/member-failure-is-isolated', async () => {
  const group = new TaskGroup();
  const control = controllable();
  const failing = group.run('bad', async () => { throw new Error('成员失败'); });
  control.finishes.length = 0;
  const healthy = group.run('good', control.work('good'));
  assert.equal(await rejectionOf(failing), 'other:Error: 成员失败');
  control.finishes[0]?.();
  assert.equal(await healthy, 'done:good');
});
