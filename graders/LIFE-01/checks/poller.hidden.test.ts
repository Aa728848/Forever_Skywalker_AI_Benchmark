import test from 'node:test';
import assert from 'node:assert/strict';
import { Poller, type Scheduler, type Timer } from '../starter/src/poller.ts';

interface Record {
  intervalMs: number;
  run: () => void;
  cancelCount: number;
  timer: Timer;
}

/** 可控调度器：记录注册顺序与取消次数，可手动触发任意未取消的定时器。 */
function fakeScheduler() {
  const timers: Record[] = [];
  const scheduler: Scheduler = {
    every(intervalMs, run) {
      const record: Record = { intervalMs, run, cancelCount: 0, timer: null as unknown as Timer };
      const timer: Timer = { cancel() { record.cancelCount += 1; } };
      record.timer = timer;
      timers.push(record);
      return timer;
    },
  };
  return {
    scheduler,
    timers,
    live: () => timers.filter(timer => timer.cancelCount === 0),
    cancels: () => timers.reduce((sum, timer) => sum + timer.cancelCount, 0),
    fireLive: () => { for (const timer of timers) if (timer.cancelCount === 0) timer.run(); },
  };
}

test('hidden/repeated-start-does-not-duplicate-ticks', () => {
  const fake = fakeScheduler();
  let ticks = 0;
  const poller = new Poller(() => { ticks += 1; }, fake.scheduler, 250);
  // 契约第 1 条：重复 start 既不建第二个定时器，也不重复触发。
  for (let i = 0; i < 4; i += 1) poller.start();
  assert.equal(fake.timers.length, 1, '重复 start 注册了多个定时器');
  assert.equal(poller.activeTimers, 1);
  assert.equal(poller.running, true);
  fake.fireLive();
  assert.equal(ticks, 1, '重复 start 导致同一周期被触发多次');
  assert.equal(fake.timers[0]!.intervalMs, 250, '重复 start 覆盖了约定的间隔');
  assert.equal(fake.cancels(), 0, '重复 start 不应取消任何定时器');
});

test('hidden/stop-cancels-exactly-once-and-keeps-counting', () => {
  const fake = fakeScheduler();
  const poller = new Poller(() => {}, fake.scheduler);
  poller.start();
  poller.stop();
  // 契约第 2 条：必须真的调用 Timer.cancel()，而不是只清自己的字段。
  assert.equal(fake.cancels(), 1, 'stop 没有调用 Timer.cancel()');
  assert.equal(poller.activeTimers, 0);
  assert.equal(poller.running, false);
  // 再次 stop 必须幂等：不得重复取消。
  poller.stop();
  poller.stop();
  assert.equal(fake.cancels(), 1, '重复 stop 重复取消了定时器');
  assert.equal(poller.activeTimers, 0);
});

test('hidden/stop-marks-timer-cancelled-so-scheduler-stops-firing', () => {
  const fake = fakeScheduler();
  let ticks = 0;
  const poller = new Poller(() => { ticks += 1; }, fake.scheduler);
  poller.start();
  fake.fireLive();
  assert.equal(ticks, 1, '停止前应正常触发');
  poller.stop();
  // 契约第 2 条只要求 Timer.cancel() 被调用；被取消的定时器由调度器负责不再回调，
  // 实现不负责拦截。因此这里验证的是「取消已登记」，不是「实现自己挡回调」。
  assert.equal(fake.cancels(), 1, 'stop 没有把定时器标记为已取消');
  assert.equal(fake.live().length, 0, '调度器仍认为有存活定时器');
  fake.fireLive();
  assert.equal(ticks, 1, '调度器仍在触发已取消的定时器');
});

test('hidden/stop-without-start-is-a-no-op', () => {
  const fake = fakeScheduler();
  const poller = new Poller(() => {}, fake.scheduler);
  // 契约第 3 条：不创建、也不取消失效定时器。
  poller.stop();
  poller.stop();
  assert.equal(fake.timers.length, 0, '未启动就 stop 反而创建了定时器');
  assert.equal(fake.cancels(), 0, '未启动就 stop 取消了不存在的定时器');
  assert.equal(poller.running, false);
  assert.equal(poller.activeTimers, 0);
  // 停了之后还能正常启动。
  poller.start();
  assert.equal(poller.running, true);
  assert.equal(poller.activeTimers, 1);
  assert.equal(fake.timers.length, 1);
});

test('hidden/restart-creates-a-fresh-independent-timer', () => {
  const fake = fakeScheduler();
  let ticks = 0;
  const poller = new Poller(() => { ticks += 1; }, fake.scheduler, 100);
  poller.start();
  poller.stop();
  poller.start();
  // 契约第 4 条：新定时器与旧定时器相互独立。
  assert.equal(fake.timers.length, 2, '重启没有创建新定时器');
  assert.equal(fake.cancels(), 1, '重启时旧定时器没有被取消');
  assert.equal(fake.live().length, 1, '重启后存活的定时器不是恰好一个');
  assert.equal(poller.activeTimers, 1);
  // 只触发存活的：旧回调即使被调用也不应计入。
  fake.fireLive();
  assert.equal(ticks, 1, '重启后触发次数不是 1');
  // 多轮启停不得累积存活定时器。
  for (let i = 0; i < 3; i += 1) { poller.stop(); poller.start(); }
  assert.equal(fake.live().length, 1, '多轮启停后存活定时器不是 1');
  assert.equal(poller.activeTimers, 1);
});

test('hidden/default-interval-and-explicit-zero', () => {
  const fake = fakeScheduler();
  // 契约第 5 条：缺省 1000ms。
  new Poller(() => {}, fake.scheduler).start();
  assert.equal(fake.timers[0]!.intervalMs, 1000);
  // 显式 0 必须被原样传给调度器，不得被当成缺省。
  const zero = fakeScheduler();
  new Poller(() => {}, zero.scheduler, 0).start();
  assert.equal(zero.timers[0]!.intervalMs, 0, '显式 0 被当成了缺省值');
  // 显式值覆盖缺省，且 stop/start 不会改写它。
  const custom = fakeScheduler();
  const poller = new Poller(() => {}, custom.scheduler, 42);
  poller.start();
  poller.stop();
  poller.start();
  assert.equal(custom.timers.every(timer => timer.intervalMs === 42), true, '重启后间隔被改写');
});

test('hidden/two-pollers-on-one-scheduler-are-independent', () => {
  const fake = fakeScheduler();
  let a = 0;
  let b = 0;
  const first = new Poller(() => { a += 1; }, fake.scheduler, 10);
  const second = new Poller(() => { b += 1; }, fake.scheduler, 20);
  first.start();
  second.start();
  assert.equal(fake.timers.length, 2);
  assert.deepEqual(fake.timers.map(timer => timer.intervalMs), [10, 20]);
  // 停掉其中一个，另一个必须继续工作。
  first.stop();
  assert.equal(first.activeTimers, 0);
  assert.equal(second.activeTimers, 1);
  assert.equal(second.running, true);
  fake.fireLive();
  assert.equal(a, 0, '已停止的 poller 仍在触发');
  assert.equal(b, 1, '另一个 poller 没有继续触发');
  assert.equal(fake.live().length, 1);
});

test('hidden/tick-throwing-does-not-break-lifecycle', () => {
  // 契约只说调度器不抛；tick 抛出时的生命周期行为未被约定，
  // 这里只验证不因为一次异常就丢失定时器引用。
  const fake = fakeScheduler();
  const poller = new Poller(() => { throw new Error('tick 炸了'); }, fake.scheduler);
  poller.start();
  assert.equal(poller.activeTimers, 1);
  assert.equal(poller.running, true);
  assert.throws(() => fake.timers[0]!.run(), /tick 炸了/);
  // 异常之后仍能正常停止并释放定时器。
  poller.stop();
  assert.equal(fake.cancels(), 1, 'tick 抛异常后 stop 没有释放定时器');
  assert.equal(poller.activeTimers, 0);
  assert.equal(fake.live().length, 0);
});

test('hidden/stop-start-cycle-releases-every-timer', () => {
  const fake = fakeScheduler();
  const poller = new Poller(() => {}, fake.scheduler, 5);
  // 十轮完整启停：注册的每个定时器都必须已被取消，不得泄漏。
  for (let round = 0; round < 10; round += 1) {
    poller.start();
    assert.equal(poller.activeTimers, 1, '第 ' + round + ' 轮 start 后 activeTimers 不是 1');
    poller.stop();
    assert.equal(poller.activeTimers, 0, '第 ' + round + ' 轮 stop 后 activeTimers 不是 0');
  }
  assert.equal(fake.timers.length, 10, '每轮应各注册一个定时器');
  assert.equal(fake.live().length, 0, '存在泄漏的存活定时器');
  assert.equal(fake.cancels(), 10, '取消次数与注册次数不一致');
});
