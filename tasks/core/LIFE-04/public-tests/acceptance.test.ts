import test from 'node:test';
import assert from 'node:assert/strict';
import { AcceptanceRunner, type ChildHandle, type ChildPort } from '../starter/src/acceptance.ts';

function fakePort() {
  const children: Array<{ pid: number; exits: Array<(code: number | null, signal: string | null) => void>; killed: boolean }> = [];
  let nextPid = 100;
  const port: ChildPort = {
    spawn() {
      const record = { pid: nextPid, exits: [] as Array<(code: number | null, signal: string | null) => void>, killed: false };
      nextPid += 1;
      children.push(record);
      const handle: ChildHandle = {
        pid: record.pid,
        kill() { record.killed = true; },
        onExit(listener) { record.exits.push(listener); },
      };
      return handle;
    },
  };
  return {
    port,
    children,
    exit(index: number, code: number | null, signal: string | null = null) {
      for (const listener of children[index]?.exits ?? []) listener(code, signal);
    },
  };
}

const tick = async (): Promise<void> => { await Promise.resolve(); };

test('public/classifies-normal-exit', async () => {
  const fake = fakePort();
  const runner = new AcceptanceRunner(fake.port);
  const running = runner.accept();
  assert.equal(runner.busy, true);
  fake.exit(0, 0);
  assert.deepEqual(await running, { fault: 'exited', signal: null });
  assert.equal(runner.busy, false);
  assert.deepEqual(runner.reaped, [100]);
});

test('public/classifies-crash-and-signal', async () => {
  const fake = fakePort();
  const runner = new AcceptanceRunner(fake.port);
  const crashed = runner.accept();
  fake.exit(0, 3);
  assert.deepEqual(await crashed, { fault: 'crashed', signal: null });
  assert.equal(fake.children[0]?.killed, true, '故障子进程必须被回收');
  const killed = runner.accept();
  fake.exit(1, null, 'SIGKILL');
  assert.deepEqual(await killed, { fault: 'killed', signal: 'SIGKILL' });
  assert.deepEqual(runner.reaped, [100, 101]);
});

test('public/rejects-concurrent-acceptance', async () => {
  const fake = fakePort();
  const runner = new AcceptanceRunner(fake.port);
  const first = runner.accept();
  // 不 await 第二次调用：缺陷实现可能永远不会结算它，用副作用断言代替。
  let outcome = 'pending';
  void runner.accept().then(() => { outcome = 'resolved'; }, () => { outcome = 'rejected'; });
  await tick();
  await tick();
  assert.equal(fake.children.length, 1, '在途验收期间不得启动第二个子进程');
  assert.equal(outcome, 'rejected', '重入必须被拒绝');
  fake.exit(0, 0);
  await first;
});

test('public/allows-accept-after-completion', async () => {
  const fake = fakePort();
  const runner = new AcceptanceRunner(fake.port);
  const first = runner.accept();
  fake.exit(0, 0);
  await first;
  const second = runner.accept();
  assert.equal(fake.children.length, 2);
  fake.exit(1, 0);
  assert.equal((await second).fault, 'exited');
});

test('public/reaps-every-child-even-on-failure', async () => {
  const fake = fakePort();
  const runner = new AcceptanceRunner(fake.port);
  const first = runner.accept();
  fake.exit(0, 2);
  await first;
  const second = runner.accept();
  fake.exit(1, null, 'SIGTERM');
  await second;
  assert.deepEqual(runner.reaped, [100, 101]);
  assert.equal(runner.busy, false);
});
