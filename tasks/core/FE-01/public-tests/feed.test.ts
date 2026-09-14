import test from 'node:test';
import assert from 'node:assert/strict';
import { FeedController, type FeedItem, type FeedPage, type FeedView } from '../starter/src/feed.ts';

interface Deferred<T> { readonly promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onValue, onError) => { resolve = onValue; reject = onError; });
  return { promise, resolve, reject };
}

function item(id: string): FeedItem {
  return { id, text: '条目 ' + id };
}

function page(ids: string[], cursor: string | null): FeedPage {
  return { items: ids.map(item), cursor };
}

/** 记录视图回调，用于断言调用顺序与收到的快照。 */
function recordingView() {
  const renders: string[][] = [];
  const busyLog: boolean[] = [];
  const errorLog: (string | null)[] = [];
  const view: FeedView = {
    render(items) { renders.push(items.map(entry => entry.id)); },
    setBusy(busy) { busyLog.push(busy); },
    setError(message) { errorLog.push(message); },
  };
  return { view, renders, busyLog, errorLog };
}

test('public/initial-state-is-empty', () => {
  const controller = new FeedController(async () => page([], null), recordingView().view);
  assert.deepEqual(controller.items, []);
  assert.equal(controller.busy, false);
  assert.equal(controller.error, null);
});

test('public/appends-page-and-advances-cursor', async () => {
  const seen: (string | null)[] = [];
  const controller = new FeedController(async cursor => {
    seen.push(cursor);
    return cursor === null ? page(['a', 'b'], 'c1') : page(['c'], null);
  }, recordingView().view);
  await controller.loadMore();
  await controller.loadMore();
  assert.deepEqual(seen, [null, 'c1']);
  assert.deepEqual(controller.items.map(entry => entry.id), ['a', 'b', 'c']);
});

test('public/deduplicates-overlapping-pages', async () => {
  let call = 0;
  const controller = new FeedController(async () => {
    call += 1;
    return call === 1 ? page(['a', 'b'], 'c1') : page(['b', 'c'], null);
  }, recordingView().view);
  await controller.loadMore();
  await controller.loadMore();
  const ids = controller.items.map(entry => entry.id);
  assert.deepEqual(ids, ['a', 'b', 'c']);
  assert.equal(new Set(ids).size, ids.length);
});

test('public/failure-is-surfaced-and-recoverable', async () => {
  const view = recordingView();
  let attempt = 0;
  const controller = new FeedController(async () => {
    attempt += 1;
    if (attempt === 1) throw new Error('网络不可用');
    return page(['a'], null);
  }, view.view);
  await controller.loadMore();
  assert.equal(controller.error, '网络不可用');
  assert.equal(controller.busy, false);
  assert.deepEqual(view.busyLog, [true, false]);
  await controller.retry();
  assert.equal(controller.error, null);
  assert.deepEqual(controller.items.map(entry => entry.id), ['a']);
  assert.deepEqual(view.busyLog, [true, false, true, false]);
});

test('public/failure-keeps-items-and-cursor', async () => {
  let call = 0;
  const cursors: (string | null)[] = [];
  const controller = new FeedController(async cursor => {
    cursors.push(cursor);
    call += 1;
    if (call === 2) throw new Error('第二页失败');
    return call === 1 ? page(['a'], 'c1') : page(['b'], null);
  }, recordingView().view);
  await controller.loadMore();
  await controller.loadMore();
  assert.deepEqual(controller.items.map(entry => entry.id), ['a']);
  assert.equal(controller.error, '第二页失败');
  await controller.retry();
  assert.deepEqual(cursors, [null, 'c1', 'c1']);
  assert.deepEqual(controller.items.map(entry => entry.id), ['a', 'b']);
});

test('public/busy-blocks-concurrent-loads', async () => {
  const gate = deferred<FeedPage>();
  let calls = 0;
  const controller = new FeedController(() => { calls += 1; return gate.promise; }, recordingView().view);
  const first = controller.loadMore();
  const second = controller.loadMore();
  const third = controller.retry();
  assert.equal(calls, 1);
  gate.resolve(page(['a'], null));
  await Promise.all([first, second, third]);
  assert.equal(calls, 1);
  assert.deepEqual(controller.items.map(entry => entry.id), ['a']);
});

test('public/render-receives-snapshot', async () => {
  const view = recordingView();
  const controller = new FeedController(async () => page(['a'], null), view.view);
  await controller.loadMore();
  assert.deepEqual(view.renders, [['a']]);
  const rendered = controller.items as FeedItem[];
  rendered.push(item('x'));
  assert.deepEqual(rendered.map(entry => entry.id), ['a', 'x']);
  assert.deepEqual(controller.items.map(entry => entry.id), ['a']);
});
