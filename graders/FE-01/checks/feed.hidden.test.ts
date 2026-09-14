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

test('hidden/retry-after-partial-overlap-has-unique-ids', async () => {
  let call = 0;
  const controller = new FeedController(async () => {
    call += 1;
    if (call === 1) return page(['a', 'b'], 'c1');
    if (call === 2) throw new Error('服务端抖动');
    return page(['b', 'c', 'a'], null);
  }, recordingView().view);
  await controller.loadMore();
  await controller.loadMore();
  await controller.retry();
  const ids = controller.items.map(entry => entry.id);
  assert.deepEqual(ids, ['a', 'b', 'c']);
  assert.equal(new Set(ids).size, ids.length);
});

test('hidden/view-callback-sequence', async () => {
  const view = recordingView();
  const controller = new FeedController(async () => page(['a'], 'c1'), view.view);
  await controller.loadMore();
  assert.deepEqual(view.busyLog, [true, false]);
  assert.deepEqual(view.errorLog, [null]);
  assert.deepEqual(view.renders, [['a']]);
});

test('hidden/error-cleared-on-success', async () => {
  const view = recordingView();
  let attempt = 0;
  const controller = new FeedController(async () => {
    attempt += 1;
    if (attempt <= 1) throw new Error('失败 ' + attempt);
    return page(['a'], null);
  }, view.view);
  await controller.loadMore();
  assert.equal(controller.error, '失败 1');
  await controller.retry();
  assert.equal(controller.error, null);
  assert.equal(view.errorLog[view.errorLog.length - 1], null);
});

test('hidden/empty-page-keeps-cursor', async () => {
  let call = 0;
  const cursors: (string | null)[] = [];
  const controller = new FeedController(async cursor => {
    cursors.push(cursor);
    call += 1;
    return call === 1 ? page(['a'], 'c1') : page([], 'c1');
  }, recordingView().view);
  await controller.loadMore();
  await controller.loadMore();
  await controller.loadMore();
  assert.deepEqual(cursors, [null, 'c1', 'c1']);
  assert.deepEqual(controller.items.map(entry => entry.id), ['a']);
});

test('hidden/two-controllers-are-independent', async () => {
  const first = new FeedController(async () => page(['a'], null), recordingView().view);
  const second = new FeedController(async () => page(['b'], null), recordingView().view);
  await Promise.all([first.loadMore(), second.loadMore()]);
  assert.deepEqual(first.items.map(entry => entry.id), ['a']);
  assert.deepEqual(second.items.map(entry => entry.id), ['b']);
});

test('hidden/large-pages-stay-unique', async () => {
  let call = 0;
  const controller = new FeedController(async () => {
    call += 1;
    const ids: string[] = [];
    for (let index = 0; index < 5000; index += 1) ids.push('id-' + (call === 1 ? index : index + 2500));
    return page(ids, call === 1 ? 'next' : null);
  }, recordingView().view);
  await controller.loadMore();
  await controller.loadMore();
  const ids = controller.items.map(entry => entry.id);
  assert.equal(ids.length, 7500);
  assert.equal(new Set(ids).size, ids.length);
});
